/**
 * Mid-turn permission changes on ClaudeCodeProvider (NIM-2403).
 *
 * A turn resolves its effective session mode once and hands the derived
 * `permissionMode` to `query()` for the life of that turn. Switching the project
 * to "Allow everything" while the agent is running therefore did nothing until
 * the agent stopped — the SDK classifier kept escalating, and
 * `immediateToolDecision` deliberately refuses to let bypass-all short-circuit a
 * classifier escalation. These tests cover the push into the live query.
 */

// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => ({
  app: { ...(await import('../../../../../../electron/test-stubs/privateUserData')).testApp, isPackaged: false },
}));

vi.mock('../claudeCode/cliPathResolver', () => ({
  resolveClaudeAgentCliPath: async () => '/fake/claude',
}));

vi.mock('../../../../electron/claudeCodeEnvironment', () => ({
  setupClaudeCodeEnvironment: () => ({}),
  resolveNativeBinaryPath: () => undefined,
}));

import { ClaudeCodeProvider } from '../ClaudeCodeProvider';
import { BaseAgentProvider } from '../BaseAgentProvider';

type TrustStatus = {
  trusted: boolean;
  mode: 'ask' | 'allow-all' | 'bypass-all' | null;
  allowAllUsesClassifier?: boolean;
};

/** Register a provider as mid-turn with a fake live query. */
function streamingProvider(state: {
  requestedMode: 'planning' | 'agent' | 'auto';
  currentMode: 'planning' | 'agent' | 'auto';
  setPermissionMode?: (mode: string) => Promise<void>;
}) {
  const setPermissionMode = vi.fn(state.setPermissionMode ?? (async () => {}));
  const provider = new ClaudeCodeProvider();
  Object.assign(provider as unknown as Record<string, unknown>, {
    requestedMode: state.requestedMode,
    currentMode: state.currentMode,
    pathForTrust: '/proj',
    leadQuery: { setPermissionMode },
  });
  (ClaudeCodeProvider as unknown as { streamingInstances: Set<unknown> }).streamingInstances.add(provider);
  return { provider, setPermissionMode };
}

const modeOf = (provider: ClaudeCodeProvider) =>
  (provider as unknown as { currentMode?: string }).currentMode;

function trustIs(status: TrustStatus) {
  ClaudeCodeProvider.setTrustChecker(() => status);
}

describe('ClaudeCodeProvider mid-turn permission changes', () => {
  afterEach(() => {
    (ClaudeCodeProvider as unknown as { streamingInstances: Set<unknown> }).streamingInstances.clear();
    BaseAgentProvider.setTrustChecker(null);
    vi.restoreAllMocks();
  });

  it('drops a turn out of classifier mode when the project switches to Allow everything', async () => {
    const { provider, setPermissionMode } = streamingProvider({
      requestedMode: 'agent',
      currentMode: 'auto',
    });
    trustIs({ trusted: true, mode: 'bypass-all', allowAllUsesClassifier: false });

    await ClaudeCodeProvider.applyPermissionChange();

    expect(setPermissionMode).toHaveBeenCalledWith('default');
    expect(modeOf(provider)).toBe('agent');
  });

  it('turns the classifier on mid-turn when the project switches to Agent-verified', async () => {
    const { provider, setPermissionMode } = streamingProvider({
      requestedMode: 'agent',
      currentMode: 'agent',
    });
    trustIs({ trusted: true, mode: 'bypass-all', allowAllUsesClassifier: true });

    await ClaudeCodeProvider.applyPermissionChange();

    expect(setPermissionMode).toHaveBeenCalledWith('auto');
    expect(modeOf(provider)).toBe('auto');
  });

  it('leaves an explicitly-requested auto session alone', async () => {
    const { provider, setPermissionMode } = streamingProvider({
      requestedMode: 'auto',
      currentMode: 'auto',
    });
    trustIs({ trusted: true, mode: 'bypass-all', allowAllUsesClassifier: false });

    await ClaudeCodeProvider.applyPermissionChange();

    expect(setPermissionMode).not.toHaveBeenCalled();
    expect(modeOf(provider)).toBe('auto');
  });

  it('does not touch the SDK when the effective mode is unchanged', async () => {
    const { setPermissionMode } = streamingProvider({
      requestedMode: 'agent',
      currentMode: 'agent',
    });
    trustIs({ trusted: true, mode: 'ask', allowAllUsesClassifier: false });

    await ClaudeCodeProvider.applyPermissionChange();

    expect(setPermissionMode).not.toHaveBeenCalled();
  });

  it('rolls the tracked mode back when the SDK call fails on a dead transport', async () => {
    const { provider, setPermissionMode } = streamingProvider({
      requestedMode: 'agent',
      currentMode: 'auto',
      setPermissionMode: async () => {
        throw new Error('transport closed');
      },
    });
    trustIs({ trusted: true, mode: 'bypass-all', allowAllUsesClassifier: false });

    await ClaudeCodeProvider.applyPermissionChange();

    expect(setPermissionMode).toHaveBeenCalled();
    // canUseTool must keep honouring the mode the turn actually runs under.
    expect(modeOf(provider)).toBe('auto');
  });
});

// #1740: an Agent-verified (auto) query's escalated call must wait for the user even in
// bypass-all, but a teammate query runs 'default' and keeps the bypass-all shortcut.
describe('ClaudeCodeProvider canUseTool under an Agent-verified lead', () => {
  afterEach(() => {
    BaseAgentProvider.setTrustChecker(null);
    vi.restoreAllMocks();
  });

  function autoLeadInBypassAll() {
    const requestToolPermission = vi.fn(async () => ({ decision: 'deny' as const, scope: 'once' as const }));
    const provider = new ClaudeCodeProvider();
    Object.assign(provider as unknown as Record<string, unknown>, {
      currentMode: 'auto',
      permissionService: { requestToolPermission },
    });
    vi.spyOn(provider as any, 'logAgentMessage').mockResolvedValue(undefined);
    trustIs({ trusted: true, mode: 'bypass-all', allowAllUsesClassifier: true });
    const handler = (...args: unknown[]) => (provider as any).createCanUseToolHandler('session', '/proj', '/proj', ...args);
    const call = (canUseTool: any) =>
      canUseTool('Bash', { command: 'touch /tmp/ask-probe-1' }, { signal: new AbortController().signal });
    return { requestToolPermission, handler, call };
  }

  it('asks the permission service to wait for the user on the lead query', async () => {
    const { requestToolPermission, handler, call } = autoLeadInBypassAll();
    expect(await call(handler())).toMatchObject({ behavior: 'deny' });
    expect(requestToolPermission).toHaveBeenCalledWith(expect.objectContaining({ requiresUserDecision: 'escalated' }));
  });

  it('keeps the bypass-all shortcut for a teammate query running in default mode', async () => {
    const { requestToolPermission, handler, call } = autoLeadInBypassAll();
    expect(await call(handler('teammate-a', 'default'))).toMatchObject({ behavior: 'allow' });
    expect(requestToolPermission).not.toHaveBeenCalled();
  });
});

// #1741: a hook "ask" on a compound command is answered as a whole. Splitting it would let
// sub-commands approved earlier this session run without the prompt the hook asked for.
describe('ClaudeCodeProvider canUseTool with a PreToolUse hook ask', () => {
  afterEach(() => {
    BaseAgentProvider.setTrustChecker(null);
    vi.restoreAllMocks();
  });

  it('prompts once for the whole compound command even when its parts are approved', async () => {
    const requestToolPermission = vi.fn(async () => ({ decision: 'deny' as const, scope: 'once' as const }));
    const provider = new ClaudeCodeProvider();
    Object.assign(provider as unknown as Record<string, unknown>, {
      currentMode: 'agent',
      permissionService: { requestToolPermission, getSessionApprovedPatterns: () => new Set(['Bash(ls:*)', 'Bash(touch:*)']) },
    });
    vi.spyOn(provider as any, 'logAgentMessage').mockResolvedValue(undefined);
    trustIs({ trusted: true, mode: 'allow-all' });
    const canUseTool = (provider as any).createCanUseToolHandler('session', '/proj', '/proj');
    const command = 'ls && touch /tmp/ask-probe-9';
    const result = await canUseTool('Bash', { command }, { signal: new AbortController().signal, decisionReasonType: 'hook' });
    expect(result).toMatchObject({ behavior: 'deny' });
    expect(requestToolPermission).toHaveBeenCalledTimes(1);
    expect(requestToolPermission).toHaveBeenCalledWith(expect.objectContaining({ toolInput: { command }, requiresUserDecision: 'hook-ask' }));
  });
});
