/**
 * #1682: sessions with a `developer_git_commit_proposal` commit in flight.
 *
 * Interrupting the turn while a proposal commits makes the SDK write its
 * standard "user doesn't want to proceed" text as the tool result while the
 * commit may still land. Send-now, meta-agent interrupts and teammate messages
 * wait here until it settles instead. A real Stop (cancel/abort) does not
 * consult this and is always honored.
 *
 * Only the commit itself is held, not the human wait before it: a proposal
 * waiting on the user must not hold the user's own next message. A proposal's
 * commit holds from the moment it starts until that proposal's call has
 * returned its result (`holdCommitProposalCall`), so the agent always reads
 * the commit's own outcome.
 */
const inFlight = new Map<string, number>();
const waiters = new Map<string, Array<() => void>>();
/** Execution ends deferred until their proposal's call returns, by session and proposal. */
const heldCalls = new Map<string, Array<() => void>>();

function callKey(sessionId: string, proposalId: string): string {
  return JSON.stringify([sessionId, proposalId]);
}

/** Marks a commit in flight; the returned function ends it (idempotent). */
export function beginCommitProposalCall(sessionId: string): () => void {
  inFlight.set(sessionId, (inFlight.get(sessionId) ?? 0) + 1);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const remaining = (inFlight.get(sessionId) ?? 1) - 1;
    if (remaining > 0) {
      inFlight.set(sessionId, remaining);
      return;
    }
    inFlight.delete(sessionId);
    const pending = waiters.get(sessionId) ?? [];
    waiters.delete(sessionId);
    for (const wake of pending) wake();
  };
}

/**
 * A proposal's MCP call is open. Holds nothing by itself; a commit of this
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

/**
 * A proposal's commit starts. The returned function ends it (idempotent); the
 * mark then stays until the proposal's call returns, or ends at once when no
 * call is waiting for this commit (a stale card answered after a restart).
 */
export function beginCommitProposalExecution(sessionId: string, proposalId: string): () => void {
  const end = beginCommitProposalCall(sessionId);
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    const held = heldCalls.get(callKey(sessionId, proposalId));
    if (held) held.push(end);
    else end();
  };
}

export function isCommitProposalInFlight(sessionId: string | undefined): boolean {
  return !!sessionId && inFlight.has(sessionId);
}

/** Runs `action` now, or once the session's in-flight commit calls have all settled. */
export async function afterCommitProposalSettles<T>(
  sessionId: string | undefined,
  action: () => T | Promise<T>,
): Promise<T> {
  if (sessionId && inFlight.has(sessionId)) {
    await new Promise<void>(wake => {
      const list = waiters.get(sessionId) ?? [];
      list.push(wake);
      waiters.set(sessionId, list);
    });
  }
  return action();
}
