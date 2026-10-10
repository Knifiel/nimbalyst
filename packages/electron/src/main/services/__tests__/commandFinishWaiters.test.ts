// @vitest-environment node
/**
 * An agent spawned into a new worktree must not start before the worktree's
 * setup command (an install) finishes. The shell reports cmd-end for its first
 * prompt before the setup command starts; that one must not count.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CommandFinishWaiters, type CommandWaitOutcome } from '../commandFinishWaiters';

const options = { runningNow: false, startTimeoutMs: 1_000, finishTimeoutMs: 60_000 };
let waiters: CommandFinishWaiters;

beforeEach(() => {
  vi.useFakeTimers();
  waiters = new CommandFinishWaiters();
});
afterEach(() => vi.useRealTimers());

function track(promise: Promise<CommandWaitOutcome>): { outcome?: CommandWaitOutcome } {
  const result: { outcome?: CommandWaitOutcome } = {};
  void promise.then(outcome => { result.outcome = outcome; });
  return result;
}

it('finishes on the cmd-end that follows the command, not the first prompt\'s', async () => {
  const wait = track(waiters.wait('t1', options));
  waiters.onCommandState('t1', 'cmd-end');
  waiters.onCommandState('t1', 'cmd-start');
  waiters.onCommandState('t2', 'cmd-end');
  await vi.advanceTimersByTimeAsync(30_000);
  expect(wait.outcome).toBeUndefined();

  waiters.onCommandState('t1', 'cmd-end');
  await vi.advanceTimersByTimeAsync(0);
  expect(wait.outcome).toBe('finished');
});

it('counts a command already running when the wait begins', async () => {
  const wait = track(waiters.wait('t1', { ...options, runningNow: true }));
  waiters.onCommandState('t1', 'cmd-end');
  await vi.advanceTimersByTimeAsync(0);
  expect(wait.outcome).toBe('finished');
});

it('gives up when the shell never reports a command, and caps a command that never ends', async () => {
  const silent = track(waiters.wait('t1', options));
  await vi.advanceTimersByTimeAsync(1_000);
  expect(silent.outcome).toBe('no-command-state');

  const endless = track(waiters.wait('t2', options));
  await vi.advanceTimersByTimeAsync(900);
  waiters.onCommandState('t2', 'cmd-start');
  await vi.advanceTimersByTimeAsync(59_000);
  expect(endless.outcome).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(endless.outcome).toBe('timeout');
});

it('settles every wait on a terminal when it exits', async () => {
  const first = track(waiters.wait('t1', options));
  const second = track(waiters.wait('t1', { ...options, runningNow: true }));
  waiters.onExit('t1');
  await vi.advanceTimersByTimeAsync(0);
  expect([first.outcome, second.outcome]).toEqual(['exited', 'exited']);
});
