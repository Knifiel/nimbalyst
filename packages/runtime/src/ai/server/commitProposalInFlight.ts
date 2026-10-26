/**
 * #1682: sessions with a `developer_git_commit_proposal` call or commit in flight.
 *
 * Interrupting the turn during that call makes the SDK write its standard
 * "user doesn't want to proceed" text as the tool result while the commit may
 * still land, or while the card stays committable. Meta-agent interrupts and
 * teammate messages wait until the whole call settles, the wait for the user
 * included (`beginCommitProposalCall`). A real Stop (cancel/abort) does not
 * consult this and is always honored.
 *
 * The user's own send-now is the exception: it goes through a proposal that is
 * waiting on them, which it closes for good. It waits only for a commit the
 * user already confirmed. A confirmed commit holds from the moment the Confirm
 * is accepted (`beginCommitProposalConfirm`) and, once it starts
 * (`beginCommitProposalExecution`), until that proposal's call has returned its
 * result (`holdCommitProposalCall`), so the agent always reads the commit's own
 * outcome.
 */

interface Holds {
  /** Adds a hold on `key`; the returned function removes it (idempotent). */
  begin(key: string): () => void;
  has(key: string): boolean;
  /** Resolves once `key` has no holds left. */
  whenClear(key: string): Promise<void>;
}

function createHolds(): Holds {
  const counts = new Map<string, number>();
  const waiters = new Map<string, Array<() => void>>();
  return {
    begin(key) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        const remaining = (counts.get(key) ?? 1) - 1;
        if (remaining > 0) {
          counts.set(key, remaining);
          return;
        }
        counts.delete(key);
        const pending = waiters.get(key) ?? [];
        waiters.delete(key);
        for (const wake of pending) wake();
      };
    },
    has: key => counts.has(key),
    whenClear(key) {
      if (!counts.has(key)) return Promise.resolve();
      return new Promise<void>(wake => {
        const list = waiters.get(key) ?? [];
        list.push(wake);
        waiters.set(key, list);
      });
    },
  };
}

/** By session: open proposal calls and commits. Holds every interrupt except the user's own. */
const calls = createHolds();
/** By session: commits the user confirmed. Holds every interrupt, the user's own included. */
const commits = createHolds();
/** The same commits by proposal, so its waiter refuses a release or a supersede. */
const proposalCommits = createHolds();
/** Execution ends deferred until their proposal's call returns, by session and proposal. */
const heldCalls = new Map<string, Array<() => void>>();

function callKey(sessionId: string, proposalId: string): string {
  return JSON.stringify([sessionId, proposalId]);
}

/** Marks a proposal call (or a commit) in flight; the returned function ends it (idempotent). */
export function beginCommitProposalCall(sessionId: string): () => void {
  return calls.begin(sessionId);
}

/**
 * A proposal's MCP call is open. Marks nothing by itself; a commit of this
 * proposal that starts meanwhile stays in flight until the returned function
 * runs (idempotent).
 */
export function holdCommitProposalCall(sessionId: string, proposalId: string): () => void {
  const key = callKey(sessionId, proposalId);
  const deferred: Array<() => void> = [];
  heldCalls.set(key, deferred);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (heldCalls.get(key) === deferred) heldCalls.delete(key);
    for (const end of deferred.splice(0)) end();
  };
}

function beginCommitHolds(sessionId: string, proposalId: string): () => void {
  const ends = [calls.begin(sessionId), commits.begin(sessionId), proposalCommits.begin(callKey(sessionId, proposalId))];
  return () => { for (const endHold of ends) endHold(); };
}

/**
 * The user's Confirm for a proposal was accepted and its commit is about to
 * start. Holds like an execution from this moment, and the returned function
 * ends it at once (idempotent): the commit's own execution mark takes over
 * once it starts, and a Confirm that never reached the commit holds nothing.
 */
export function beginCommitProposalConfirm(sessionId: string, proposalId: string): () => void {
  return beginCommitHolds(sessionId, proposalId);
}

/**
 * A proposal's commit starts. The returned function ends it (idempotent); the
 * mark then stays until the proposal's call returns, or ends at once when no
 * call is waiting for this commit (a stale card answered after a restart).
 */
export function beginCommitProposalExecution(sessionId: string, proposalId: string): () => void {
  const key = callKey(sessionId, proposalId);
  const end = beginCommitHolds(sessionId, proposalId);
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    const held = heldCalls.get(key);
    if (held) held.push(end);
    else end();
  };
}

/** A proposal call or commit is open: holds teammate and meta-agent interrupts. */
export function isCommitProposalInFlight(sessionId: string | undefined): boolean {
  return !!sessionId && calls.has(sessionId);
}

/** A commit the user confirmed is running or unreported, for the session or one proposal. */
export function isCommitProposalExecuting(sessionId: string | undefined, proposalId?: string): boolean {
  if (!sessionId) return false;
  return proposalId === undefined ? commits.has(sessionId) : proposalCommits.has(callKey(sessionId, proposalId));
}

/** Runs `action` now, or once the session's proposal calls and commits have all settled. */
export async function afterCommitProposalSettles<T>(
  sessionId: string | undefined,
  action: () => T | Promise<T>,
): Promise<T> {
  if (sessionId) await calls.whenClear(sessionId);
  return action();
}

/** Runs `action` now, or once the session's confirmed commits have all been reported. */
export async function afterCommitProposalExecutionSettles<T>(
  sessionId: string | undefined,
  action: () => T | Promise<T>,
): Promise<T> {
  if (sessionId) await commits.whenClear(sessionId);
  return action();
}
