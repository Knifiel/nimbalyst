// @vitest-environment node
import { expect, it, vi } from 'vitest';
import {
  beginCommitProposalCall,
  beginCommitProposalExecution,
  holdCommitProposalCall,
} from '@nimbalyst/runtime/ai/server/commitProposalInFlight';
import { prepareInterrupt, deferInterruptDuringCommit } from '../commitInterruptDeferral';
import { registerLiveInteractivePrompt } from '../../../mcp/tools/interactivePromptLiveness';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const deps = (pending: boolean) => {
  const calls: string[] = [];
  return {
    calls,
    hasPendingPrompts: vi.fn(async () => pending),
    interrupt: vi.fn(async () => { calls.push('interrupt'); }),
    drive: vi.fn(async () => { calls.push('drive'); }),
    logWarn: vi.fn(),
  };
};

it('does nothing when no commit call is in flight', () => {
  const d = deps(true);
  expect(deferInterruptDuringCommit('quiet', d)).toBe(false);
  expect(d.interrupt).not.toHaveBeenCalled();
});

it('replays one send-now (interrupt, then drive) only after the commit call settles', async () => {
  const end = beginCommitProposalCall('busy');
  const d = deps(true);
  expect(deferInterruptDuringCommit('busy', d)).toBe(true);
  expect(deferInterruptDuringCommit('busy', d)).toBe(true);
  await flush();
  expect(d.interrupt).not.toHaveBeenCalled();
  end();
  await flush();
  expect(d.calls).toEqual(['interrupt', 'drive']);
});

it('skips the replay when the queued prompt already went out', async () => {
  const end = beginCommitProposalCall('drained');
  const d = deps(false);
  deferInterruptDuringCommit('drained', d);
  end();
  await flush();
  expect(d.interrupt).not.toHaveBeenCalled();
  expect(d.drive).not.toHaveBeenCalled();
});

// Round 2 review: teammate and meta-agent interrupts wait out a proposal's
// whole call (above). The user's own send-now goes through a proposal that is
// waiting on them, and waits only for a commit they already confirmed.
it("lets the user's own interrupt through a proposal that is waiting on them", async () => {
  const endCall = beginCommitProposalCall('waiting');
  const d = deps(true);
  expect(deferInterruptDuringCommit('waiting', d, { userInitiated: true })).toBe(false);
  await expect(prepareInterrupt('waiting', d, { userInitiated: true })).resolves.toBe('ready');
  await expect(prepareInterrupt('waiting', deps(true))).resolves.toBe('deferred');
  endCall();
});

it("defers the user's interrupt while a commit they confirmed runs, until its call returns", async () => {
  const endCall = beginCommitProposalCall('confirmed');
  const releaseCall = holdCommitProposalCall('confirmed', 'p');
  const endExecution = beginCommitProposalExecution('confirmed', 'p');
  const d = deps(true);
  expect(deferInterruptDuringCommit('confirmed', d, { userInitiated: true })).toBe(true);
  endExecution();
  await flush();
  expect(d.interrupt).not.toHaveBeenCalled();
  releaseCall();
  await flush();
  expect(d.calls).toEqual(['interrupt', 'drive']);
  endCall();
});

// The SDK interrupt rejects a waiting proposal's call before any turn
// supersede runs; it has to close for good first, or its card stays committable.
it("closes waiting commit proposals for good before the user's interrupt, and nothing else", async () => {
  const proposal = { kind: 'git_commit_proposal' as const, promptId: 'p', settleTerminally: vi.fn(() => true) };
  const question = { kind: 'ask_user_question' as const, promptId: 'q', settleTerminally: vi.fn(() => true) };
  const unregister = [registerLiveInteractivePrompt('closing', proposal), registerLiveInteractivePrompt('closing', question)];
  await expect(prepareInterrupt('closing', deps(true))).resolves.toBe('ready');
  expect(proposal.settleTerminally).not.toHaveBeenCalled();

  await expect(prepareInterrupt('closing', deps(true), { userInitiated: true })).resolves.toBe('ready');
  expect(proposal.settleTerminally).toHaveBeenCalledWith('superseded');
  expect(question.settleTerminally).not.toHaveBeenCalled();
  unregister.forEach(undo => undo());
});
