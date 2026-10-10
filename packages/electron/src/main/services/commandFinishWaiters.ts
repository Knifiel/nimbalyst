/**
 * Waits for the next command a terminal runs to finish, from the shell's
 * command-state marks: cmd-start when a command line begins, cmd-end when the
 * prompt returns (the OSC 998 marks TerminalSessionManager's bootstrap emits).
 *
 * A terminal opened with an initial command reports cmd-end for its first
 * prompt before that command starts, so only a cmd-end that follows a
 * cmd-start finishes a wait. A shell without the bootstrap never reports
 * either; the wait gives up after `startTimeoutMs` instead of blocking.
 */

export type CommandWaitOutcome = 'finished' | 'exited' | 'no-command-state' | 'timeout';

export interface CommandWaitOptions {
  /** The terminal is running a command right now. */
  runningNow: boolean;
  /** How long to wait for the command to start. */
  startTimeoutMs: number;
  /** How long a started command may run. */
  finishTimeoutMs: number;
}

interface Waiter {
  started: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  settle(outcome: CommandWaitOutcome): void;
  arm(): void;
}

export class CommandFinishWaiters {
  private waiters = new Map<string, Set<Waiter>>();

  wait(terminalId: string, options: CommandWaitOptions): Promise<CommandWaitOutcome> {
    return new Promise(resolve => {
      const waiters = this.waiters.get(terminalId) ?? new Set<Waiter>();
      this.waiters.set(terminalId, waiters);
      const waiter: Waiter = {
        started: options.runningNow,
        timer: undefined,
        settle: (outcome) => {
          clearTimeout(waiter.timer);
          waiters.delete(waiter);
          if (waiters.size === 0) this.waiters.delete(terminalId);
          resolve(outcome);
        },
        arm: () => {
          clearTimeout(waiter.timer);
          waiter.timer = waiter.started
            ? setTimeout(() => waiter.settle('timeout'), options.finishTimeoutMs)
            : setTimeout(() => waiter.settle('no-command-state'), options.startTimeoutMs);
        },
      };
      waiters.add(waiter);
      waiter.arm();
    });
  }

  onCommandState(terminalId: string, state: 'cmd-start' | 'cmd-end'): void {
    for (const waiter of [...(this.waiters.get(terminalId) ?? [])]) {
      if (state === 'cmd-start' && !waiter.started) {
        waiter.started = true;
        waiter.arm();
      } else if (state === 'cmd-end' && waiter.started) {
        waiter.settle('finished');
      }
    }
  }

  onExit(terminalId: string): void {
    for (const waiter of [...(this.waiters.get(terminalId) ?? [])]) waiter.settle('exited');
  }
}
