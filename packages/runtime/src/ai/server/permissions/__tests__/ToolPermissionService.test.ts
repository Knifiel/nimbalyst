// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { ToolPermissionService } from '../ToolPermissionService';

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
  const request = (requiresUserDecision?: boolean) => ({
    requestId: 'request', sessionId: 'session', workspacePath: '/fixture', permissionsPath: '/fixture',
    toolName: 'Bash', toolInput: { command: 'touch /tmp/ask-probe-1' }, pattern: 'Bash(touch:*)',
    patternDisplayName: 'touch', toolDescription: 'touch', isDestructive: true,
    signal: new AbortController().signal, requiresUserDecision,
  });

  it('waits for the user and honors a deny', async () => {
    const service = createService();
    const pending = service.requestToolPermission(request(true));
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
