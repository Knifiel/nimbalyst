// @vitest-environment node
import { createStore } from 'jotai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { stytchAuthAtom } from '../../atoms/stytchAuth';

const invalidate = vi.hoisted(() => vi.fn());
const invalidateWithoutTeam = vi.hoisted(() => vi.fn());
vi.mock('../../atoms/collabDocuments', () => ({
  invalidateElectronCollabScopes: invalidate,
  invalidateElectronCollabScopeWithoutTeam: invalidateWithoutTeam,
}));

import { initCollabScopeListeners } from '../collabScopeListeners';

describe('initCollabScopeListeners', () => {
  let broadcastOrgChanged: (() => void) | undefined;
  let broadcastMatched: ((payload: { workspacePath?: string }) => void) | undefined;
  const unsubscribeOrgChanged = vi.fn();
  const unsubscribeMatched = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    broadcastOrgChanged = undefined;
    broadcastMatched = undefined;
    vi.stubGlobal('window', {
      electronAPI: {
        on: vi.fn((channel: string, listener: (payload?: any) => void) => {
          if (channel === 'team:workspace-matched') {
            broadcastMatched = listener;
            return unsubscribeMatched;
          }
          expect(channel).toBe('team:workspace-org-changed');
          broadcastOrgChanged = listener;
          return unsubscribeOrgChanged;
        }),
      },
    });
  });

  it('re-asks a workspace that settled on "no team" when main matches it to a team', () => {
    const cleanup = initCollabScopeListeners(createStore());

    broadcastMatched?.({ workspacePath: '/workspace/a' });

    expect(invalidateWithoutTeam).toHaveBeenCalledWith('/workspace/a');
    // Every other window keeps its session.
    expect(invalidate).not.toHaveBeenCalled();
    cleanup();
    expect(unsubscribeMatched).toHaveBeenCalled();
  });

  it('re-resolves the scope when the project gains an organization', () => {
    const jotaiStore = createStore();
    const cleanup = initCollabScopeListeners(jotaiStore);

    broadcastOrgChanged?.();

    expect(invalidate).toHaveBeenCalledTimes(1);
    cleanup();
    expect(unsubscribeOrgChanged).toHaveBeenCalled();
  });

  it('re-resolves on a sign-in transition but not on the initial auth hydration', () => {
    const jotaiStore = createStore();
    const cleanup = initCollabScopeListeners(jotaiStore);

    // The atom starts null while the initial fetch is in flight. Treating that
    // first write as a transition would tear down the session a signed-in
    // window has already started.
    jotaiStore.set(stytchAuthAtom, { isAuthenticated: false, user: null });
    expect(invalidate).not.toHaveBeenCalled();

    jotaiStore.set(stytchAuthAtom, { isAuthenticated: true, user: null });
    expect(invalidate).toHaveBeenCalledTimes(1);

    // Auth-state pushes arrive in bursts; only a flip is a new answer.
    jotaiStore.set(stytchAuthAtom, { isAuthenticated: true, user: null });
    jotaiStore.set(stytchAuthAtom, { isAuthenticated: true, user: null });
    expect(invalidate).toHaveBeenCalledTimes(1);

    jotaiStore.set(stytchAuthAtom, { isAuthenticated: false, user: null });
    expect(invalidate).toHaveBeenCalledTimes(2);

    cleanup();
    jotaiStore.set(stytchAuthAtom, { isAuthenticated: true, user: null });
    expect(invalidate).toHaveBeenCalledTimes(2);
  });
});
