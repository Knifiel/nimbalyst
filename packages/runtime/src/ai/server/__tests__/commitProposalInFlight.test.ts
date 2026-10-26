// @vitest-environment node
import { expect, it, vi } from 'vitest';
import {
  afterCommitProposalSettles,
  beginCommitProposalCall,
  beginCommitProposalExecution,
  holdCommitProposalCall,
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

// #1682 narrowed: a proposal waiting on the user holds nothing. Once its commit
// starts executing, interrupts wait until the call that proposed it returns, so
// the agent never gets the SDK's rejection text for a commit that landed.
it('holds interrupts from the start of a proposal commit until its call returns, not while it waits', () => {
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
