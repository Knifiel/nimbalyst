// @vitest-environment node
import { expect, it, vi } from 'vitest';
import {
  afterCommitProposalExecutionSettles,
  afterCommitProposalSettles,
  beginCommitProposalCall,
  beginCommitProposalConfirm,
  beginCommitProposalExecution,
  holdCommitProposalCall,
  isCommitProposalExecuting,
  isCommitProposalInFlight,
} from '../commitProposalInFlight';

it('holds deferred work until every in-flight commit call for the session settles', async () => {
  const action = vi.fn(() => 'ran');
  const endFirst = beginCommitProposalCall('s1');
  const endSecond = beginCommitProposalCall('s1');
  expect(isCommitProposalInFlight('s1')).toBe(true);
  expect(isCommitProposalInFlight('s2')).toBe(false);

  const deferred = afterCommitProposalSettles('s1', action);
  endFirst();
  endFirst(); // idempotent: a double settle must not release the second call
  await Promise.resolve();
  expect(action).not.toHaveBeenCalled();
  endSecond();
  await expect(deferred).resolves.toBe('ran');
  expect(isCommitProposalInFlight('s1')).toBe(false);
});

it('runs immediately when nothing is in flight or the session is unknown', async () => {
  await expect(afterCommitProposalSettles('idle', () => 1)).resolves.toBe(1);
  await expect(afterCommitProposalSettles(undefined, () => 2)).resolves.toBe(2);
});

// #1682: once a proposal's commit starts, interrupts wait until the call that
// proposed it returns, so the agent never gets the SDK's rejection text for a
// commit that landed. Opening the call alone marks nothing here.
it('holds interrupts from the start of a proposal commit until its call returns', () => {
  const releaseCall = holdCommitProposalCall('s3', 'p1');
  expect(isCommitProposalInFlight('s3')).toBe(false);

  const endExecution = beginCommitProposalExecution('s3', 'p1');
  expect(isCommitProposalInFlight('s3')).toBe(true);
  endExecution();
  expect(isCommitProposalInFlight('s3')).toBe(true);

  releaseCall();
  releaseCall();
  expect(isCommitProposalInFlight('s3')).toBe(false);
});

it('ends an execution mark at once when no call for that proposal is waiting', () => {
  const releaseOther = holdCommitProposalCall('s4', 'other');
  const endExecution = beginCommitProposalExecution('s4', 'p1');
  expect(isCommitProposalInFlight('s4')).toBe(true);
  endExecution();
  expect(isCommitProposalInFlight('s4')).toBe(false);
  releaseOther();
});

// Round 2 review: a teammate or meta-agent interrupt landing on a waiting
// proposal told the agent "rejected" while the card stayed committable. Those
// wait out the whole call; the user's own interrupt waits only for a commit
// they confirmed.
it('tells an open proposal call apart from a commit the user confirmed', async () => {
  const endCall = beginCommitProposalCall('s5');
  const releaseCall = holdCommitProposalCall('s5', 'p1');
  expect(isCommitProposalInFlight('s5')).toBe(true);
  expect(isCommitProposalExecuting('s5')).toBe(false);
  await expect(afterCommitProposalExecutionSettles('s5', () => 'now')).resolves.toBe('now');

  const endExecution = beginCommitProposalExecution('s5', 'p1');
  expect(isCommitProposalExecuting('s5')).toBe(true);
  expect(isCommitProposalExecuting('s5', 'p1')).toBe(true);
  expect(isCommitProposalExecuting('s5', 'p2')).toBe(false);
  const action = vi.fn(() => 'after');
  const deferred = afterCommitProposalExecutionSettles('s5', action);
  endExecution();
  await Promise.resolve();
  expect(action).not.toHaveBeenCalled();

  releaseCall();
  await expect(deferred).resolves.toBe('after');
  expect(isCommitProposalExecuting('s5', 'p1')).toBe(false);
  expect(isCommitProposalInFlight('s5')).toBe(true);
  endCall();
  expect(isCommitProposalInFlight('s5')).toBe(false);
});

// A Confirm that never reached its commit (mobile refusing a sibling worktree)
// must not keep holding a proposal that is still waiting on the user.
it('holds from an accepted Confirm, and lets go at once when no commit started', () => {
  const releaseCall = holdCommitProposalCall('s6', 'p1');
  const endConfirm = beginCommitProposalConfirm('s6', 'p1');
  expect(isCommitProposalExecuting('s6', 'p1')).toBe(true);
  expect(isCommitProposalInFlight('s6')).toBe(true);
  endConfirm();
  expect(isCommitProposalExecuting('s6')).toBe(false);
  expect(isCommitProposalInFlight('s6')).toBe(false);
  releaseCall();
});
