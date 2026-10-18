// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { beginCommitProposalCall } from '@nimbalyst/runtime/ai/server/commitProposalInFlight';
import { deferInterruptDuringCommit } from '../commitInterruptDeferral';

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
