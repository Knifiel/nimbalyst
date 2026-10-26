import { describe, it, expect, beforeEach, vi } from 'vitest';
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
  const prompt = (promptId: string, releasable = true) => {
    const run = vi.fn();
    const fake = { kind: 'ask_user_question' as const, promptId, settleTerminally: () => false, prepareRelease: () => releasable ? run : null };
    return { run, unregister: registerLiveInteractivePrompt('stop-s1', fake) };
  };
  const leadBlockedOn = (...toolUseIds: string[]) => ({ toolUseIds, providerPromptPending: false });

  it('releases the waiting prompts on the first Stop of a turn, and nothing on the second', () => {
    const turn = {};
    const first = prompt('q1');
    expect(releaseLivePromptsOnFirstStop('stop-s1', turn, leadBlockedOn('q1'))).toEqual(['q1']);
    expect(first.run).toHaveBeenCalledOnce();
    first.unregister();

    // The agent asked again before ending the turn: this Stop still aborts.
    const second = prompt('q2');
    expect(releaseLivePromptsOnFirstStop('stop-s1', turn, leadBlockedOn('q2'))).toEqual([]);
    // A later turn gets its own first Stop.
    expect(releaseLivePromptsOnFirstStop('stop-s1', {}, leadBlockedOn('q2'))).toEqual(['q2']);
    second.unregister();
  });

  it('aborts when nothing could be released or no turn is running', () => {
    expect(releaseLivePromptsOnFirstStop('stop-s1', {}, leadBlockedOn())).toEqual([]);
    const refused = prompt('commit', false);
    const turn = {};
    expect(releaseLivePromptsOnFirstStop('stop-s1', turn, leadBlockedOn('commit'))).toEqual([]);
    expect(releaseLivePromptsOnFirstStop('stop-s1', null, leadBlockedOn('commit'))).toEqual([]);
    refused.unregister();
    // A refused release does not spend the turn's first Stop.
    const later = prompt('q3');
    expect(releaseLivePromptsOnFirstStop('stop-s1', turn, leadBlockedOn('q3'))).toEqual(['q3']);
    later.unregister();
  });

  // Round 2 review: the release ignored what the lead was blocked on, so a
  // background subagent's prompt was released while the lead kept running.
  it("releases only the lead turn's own prompts; a subagent's keeps waiting", () => {
    const lead = prompt('q-lead');
    const sub = prompt('q-sub');
    expect(releaseLivePromptsOnFirstStop('stop-s1', {}, leadBlockedOn('q-lead'))).toEqual(['q-lead']);
    expect(lead.run).toHaveBeenCalledOnce();
    expect(sub.run).not.toHaveBeenCalled();

    // The lead is running, not waiting on a prompt: a subagent's alone aborts.
    expect(releaseLivePromptsOnFirstStop('stop-s1', {}, leadBlockedOn())).toEqual([]);
    expect(sub.run).not.toHaveBeenCalled();
    lead.unregister();
    sub.unregister();
  });

  it('aborts when the lead also waits on another tool, a permission prompt, or cannot be read', () => {
    const lead = prompt('q-lead');
    expect(releaseLivePromptsOnFirstStop('stop-s1', {}, leadBlockedOn('q-lead', 'toolu_bash'))).toEqual([]);
    expect(releaseLivePromptsOnFirstStop('stop-s1', {}, { toolUseIds: ['q-lead'], providerPromptPending: true })).toEqual([]);
    expect(releaseLivePromptsOnFirstStop('stop-s1', {}, null)).toEqual([]);
    expect(lead.run).not.toHaveBeenCalled();
    lead.unregister();
  });

  it("releases all of the lead's prompts or none", () => {
    const open = prompt('q-open');
    const refused = prompt('q-commit', false);
    expect(releaseLivePromptsOnFirstStop('stop-s1', {}, leadBlockedOn('q-open', 'q-commit'))).toEqual([]);
    expect(open.run).not.toHaveBeenCalled();
    open.unregister();
    refused.unregister();
  });

  it('keeps a released prompt answerable', () => {
    for (const kind of ['ask_user_question', 'request_user_input', 'git_commit_proposal'] as const) {
      expect(shouldTerminalizePrompt({ kind, reason: 'user-released' })).toBe(false);
    }
  });
});
