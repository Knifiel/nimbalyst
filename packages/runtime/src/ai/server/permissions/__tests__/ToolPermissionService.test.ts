// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { ToolPermissionService } from '../ToolPermissionService';
import { generateToolPattern, matchesAllowPattern } from '../toolPermissionHelpers';

vi.mock('../../../../storage/repositories/AgentMessagesRepository', () => ({ AgentMessagesRepository: class {} }));

describe('SDK permission prompt constraints', () => {
  it.each(['session', 'always', 'always-all'] as const)('does not cache or persist a constrained %s response', async (scope) => {
    const emit = vi.fn();
    const patternSaver = vi.fn();
    const service = new ToolPermissionService({
      trustChecker: () => ({ trusted: true, mode: 'ask' }),
      patternSaver,
      patternChecker: async () => false,
      emit,
    });
    vi.spyOn(service as any, 'pollForPermissionResponse').mockResolvedValue(undefined);
    const hints = { defaultToNo: true, suppressAlwaysAllowRule: true };
    const pending = service.requestToolPermission({
      requestId: 'request', sessionId: 'session', workspacePath: '/fixture', permissionsPath: '/fixture',
      toolName: 'Bash', toolInput: { command: 'npm test' }, pattern: 'Bash(npm test:*)',
      patternDisplayName: 'npm test', toolDescription: 'Run tests', isDestructive: false,
      signal: new AbortController().signal, ...hints,
    });
    await vi.waitFor(() => expect(service.hasPendingPermissions()).toBe(true));
    service.resolvePermission('request', { decision: 'allow', scope });
    expect(await pending).toEqual({ decision: 'allow', scope: 'once' });
    expect(patternSaver).not.toHaveBeenCalled();
    expect(service.getSessionApprovedPatterns().size).toBe(0);
    expect(emit).toHaveBeenCalledWith('toolPermission:pending', expect.objectContaining({ request: expect.objectContaining(hints) }));
  });
});

// #1740: in Agent-verified bypass-all mode, a call escalated to the user (hook "ask" or the
// classifier) must wait for an answer instead of being auto-approved under the drawn card.
describe('bypass-all with a required user decision', () => {
  function createService() {
    const service = new ToolPermissionService({
      trustChecker: () => ({ trusted: true, mode: 'bypass-all' }),
      patternSaver: vi.fn(),
      patternChecker: async () => false,
      emit: vi.fn(),
    });
    vi.spyOn(service as any, 'pollForPermissionResponse').mockResolvedValue(undefined);
    return service;
  }
  const request = (requiresUserDecision?: 'escalated') => ({
    requestId: 'request', sessionId: 'session', workspacePath: '/fixture', permissionsPath: '/fixture',
    toolName: 'Bash', toolInput: { command: 'touch /tmp/ask-probe-1' }, pattern: 'Bash(touch:*)',
    patternDisplayName: 'touch', toolDescription: 'touch', isDestructive: true,
    signal: new AbortController().signal, requiresUserDecision,
  });

  it('waits for the user and honors a deny', async () => {
    const service = createService();
    const pending = service.requestToolPermission(request('escalated'));
    await vi.waitFor(() => expect(service.hasPendingPermissions()).toBe(true));
    service.resolvePermission('request', { decision: 'deny', scope: 'once' });
    expect(await pending).toEqual({ decision: 'deny', scope: 'once' });
  });

  it('still auto-approves when no user decision is required', async () => {
    const service = createService();
    expect(await service.requestToolPermission(request())).toEqual({ decision: 'allow', scope: 'once' });
    expect(service.hasPendingPermissions()).toBe(false);
  });
});

// #1741: a PreToolUse hook "ask" must reach the user every time. A Session click, a saved
// Always rule, or the allow-edits shortcut must not answer it. Ordinary requests keep them.
describe('hook ask overrides remembered approvals', () => {
  function createService(saved: string[] = []) {
    const service = new ToolPermissionService({
      trustChecker: () => ({ trusted: true, mode: 'allow-all' }),
      patternSaver: vi.fn(),
      patternChecker: async (_path, pattern) => saved.some(allow => matchesAllowPattern(pattern, allow)),
      emit: vi.fn(),
    });
    vi.spyOn(service as any, 'pollForPermissionResponse').mockResolvedValue(undefined);
    return service;
  }
  const request = (command: string, requiresUserDecision?: 'hook-ask', toolName = 'Bash') => ({
    requestId: `request-${command}`, sessionId: 'session', workspacePath: '/fixture', permissionsPath: '/fixture',
    toolName, toolInput: { command }, pattern: generateToolPattern(toolName, { command }),
    patternDisplayName: command, toolDescription: command, isDestructive: true,
    signal: new AbortController().signal, requiresUserDecision,
  });
  async function answer(service: ToolPermissionService, req: ReturnType<typeof request>, scope: 'once' | 'session' | 'always') {
    const pending = service.requestToolPermission(req);
    await vi.waitFor(() => expect(service.hasPendingPermissions()).toBe(true));
    service.resolvePermission(req.requestId, { decision: 'allow', scope });
    return pending;
  }

  it('still prompts for a hook ask after a Session approval of the same pattern', async () => {
    const service = createService();
    await answer(service, request('touch /tmp/ask-probe-8', 'hook-ask'), 'session');
    const pending = service.requestToolPermission(request('touch /tmp/ask-probe-9', 'hook-ask'));
    await vi.waitFor(() => expect(service.hasPendingPermissions()).toBe(true));
    service.resolvePermission('request-touch /tmp/ask-probe-9', { decision: 'deny', scope: 'once' });
    expect(await pending).toEqual({ decision: 'deny', scope: 'once' });
  });

  it('still prompts for a hook ask that a saved Always rule covers', async () => {
    const service = createService(['Bash(touch:*)']);
    service.requestToolPermission(request('touch /tmp/ask-probe-9', 'hook-ask'));
    await vi.waitFor(() => expect(service.hasPendingPermissions()).toBe(true));
  });

  it('still prompts for a hook ask on a file edit under Allow edits only', async () => {
    const service = createService();
    service.requestToolPermission(request('edit', 'hook-ask', 'Edit'));
    await vi.waitFor(() => expect(service.hasPendingPermissions()).toBe(true));
  });

  it('keeps Session approvals and saved rules for ordinary requests', async () => {
    const service = createService(['Bash(gh:*)']);
    await answer(service, request('touch /tmp/a'), 'session');
    expect(await service.requestToolPermission(request('touch /tmp/b'))).toEqual({ decision: 'allow', scope: 'session' });
    expect(await service.requestToolPermission(request('gh pr merge 12'))).toEqual({ decision: 'allow', scope: 'always' });
  });
});
