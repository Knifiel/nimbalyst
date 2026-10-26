import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearLiveInteractivePrompt,
  countLiveInteractivePrompts,
  hasLiveInteractivePrompt,
  noteLiveInteractivePrompt,
  registerLiveInteractivePrompt,
  releaseLivePromptsOnFirstStop,
} from '../tools/interactivePromptLiveness';
import { shouldTerminalizePrompt } from '../tools/interactivePromptAbandonment';
import {
  clearPendingInteractiveWaiter,
  countPendingInteractiveWaiters,
  notePendingInteractiveWaiter,
  shouldSettleFromSessionFallback,
} from '../tools/interactivePromptFallback';

const drain = (sessionId: string) => {
  while (countLiveInteractivePrompts(sessionId) > 0) clearLiveInteractivePrompt(sessionId);
  while (countPendingInteractiveWaiters(sessionId) > 0) clearPendingInteractiveWaiter(sessionId);
};

describe('interactivePromptLiveness (NIM-2208)', () => {
  beforeEach(() => {
    drain('s1');
    drain('s2');
  });

  it('counts prompts per session and does not leak across sessions', () => {
    noteLiveInteractivePrompt('s1');
    noteLiveInteractivePrompt('s1');
    expect(countLiveInteractivePrompts('s1')).toBe(2);
    expect(hasLiveInteractivePrompt('s1')).toBe(true);
    expect(countLiveInteractivePrompts('s2')).toBe(0);
    expect(hasLiveInteractivePrompt('s2')).toBe(false);
  });

  it('settles back to zero and does not underflow on an extra clear', () => {
    noteLiveInteractivePrompt('s1');
    clearLiveInteractivePrompt('s1');
    clearLiveInteractivePrompt('s1');
    expect(countLiveInteractivePrompts('s1')).toBe(0);
    expect(hasLiveInteractivePrompt('s1')).toBe(false);
  });

  it('is a SEPARATE counter from the NIM-1981 fallback registry', () => {
    // The reconcile registry is incremented by every prompt type that sets
    // `hasPendingPrompt`. The fallback registry must keep counting only
    // RequestUserInput waiters, because `shouldSettleFromSessionFallback` treats
    // "count <= 1" as "sole pending prompt for this session, so an unmatched id
    // is unambiguous". Folding the other prompt types into that counter would
    // push it to 2 and reject a correct answer, hanging the turn.
    noteLiveInteractivePrompt('s1');
    noteLiveInteractivePrompt('s1');
    expect(countPendingInteractiveWaiters('s1')).toBe(0);

    notePendingInteractiveWaiter('s1');
    expect(shouldSettleFromSessionFallback({
      waiterPromptId: 'prompt-1',
      promptIdAliasSet: new Set(['prompt-1']),
      responsePromptIds: ['unmatched-id'],
      pendingWaiterCountForSession: countPendingInteractiveWaiters('s1'),
    })).toBe(true);
  });
});

// #1116: a desktop Stop of a turn blocked on a prompt releases the prompt
// instead of aborting, so background subagents keep running. A second Stop of
// the same turn aborts.
describe('releaseLivePromptsOnFirstStop', () => {
  const prompt = (promptId: string, release = true) => {
    const fake = { kind: 'ask_user_question' as const, promptId, settleTerminally: () => false, release: () => release };
    return { fake, unregister: registerLiveInteractivePrompt('stop-s1', fake) };
  };

  it('releases the waiting prompts on the first Stop of a turn, and nothing on the second', () => {
    const turn = {};
    const first = prompt('q1');
    expect(releaseLivePromptsOnFirstStop('stop-s1', turn)).toEqual(['q1']);
    first.unregister();

    // The agent asked again before ending the turn: this Stop still aborts.
    const second = prompt('q2');
    expect(releaseLivePromptsOnFirstStop('stop-s1', turn)).toEqual([]);
    // A later turn gets its own first Stop.
    expect(releaseLivePromptsOnFirstStop('stop-s1', {})).toEqual(['q2']);
    second.unregister();
  });

  it('aborts when nothing could be released or no turn is running', () => {
    expect(releaseLivePromptsOnFirstStop('stop-s1', {})).toEqual([]);
    const refused = prompt('commit', false);
    const turn = {};
    expect(releaseLivePromptsOnFirstStop('stop-s1', turn)).toEqual([]);
    expect(releaseLivePromptsOnFirstStop('stop-s1', null)).toEqual([]);
    refused.unregister();
    // A refused release does not spend the turn's first Stop.
    const later = prompt('q3');
    expect(releaseLivePromptsOnFirstStop('stop-s1', turn)).toEqual(['q3']);
    later.unregister();
  });

  it('keeps a released prompt answerable', () => {
    for (const kind of ['ask_user_question', 'request_user_input', 'git_commit_proposal'] as const) {
      expect(shouldTerminalizePrompt({ kind, reason: 'user-released' })).toBe(false);
    }
  });
});
