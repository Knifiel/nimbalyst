/**
 * The user's answer to an ExitPlanMode request, and the tool result text it
 * becomes when the plan is not approved in place.
 *
 * "Implement in a new session" and "implement in a new worktree" stop the
 * planning session instead of approving it, so the SDK records a denial. The
 * tool result is the only record the plan widget has after a reload, so a
 * deferral gets its own wording there and the widget reads it back instead of
 * showing "Denied".
 */

export type ExitPlanModeDeferral =
  | { kind: 'session' }
  | { kind: 'worktree'; worktreeName: string | null };

export interface ExitPlanModeResponse {
  approved: boolean;
  clearContext?: boolean;
  feedback?: string;
  /** Set when the plan is implemented in another session instead of this one. */
  deferredTo?: ExitPlanModeDeferral;
}

const DEFERRED_PREFIX = 'The user deferred implementation to a new session';
const WORKTREE_NAME_PATTERN = new RegExp(`${DEFERRED_PREFIX} in worktree "(.*)"\\.`);
const NEW_WORKTREE_PATTERN = new RegExp(`${DEFERRED_PREFIX} in a new worktree\\.`);

/** The reason the SDK records when the user did not approve in place. */
export function exitPlanModeDenialReason(response: ExitPlanModeResponse): string {
  const deferredTo = response.deferredTo;
  if (deferredTo?.kind === 'worktree') {
    return deferredTo.worktreeName
      ? `${DEFERRED_PREFIX} in worktree "${deferredTo.worktreeName}".`
      : `${DEFERRED_PREFIX} in a new worktree.`;
  }
  if (deferredTo?.kind === 'session') {
    return `${DEFERRED_PREFIX}.`;
  }
  const feedbackText = response.feedback
    ? `\n\nUser feedback: "${response.feedback}"`
    : '';
  return `The user chose to continue planning.${feedbackText}`;
}

/** Reads a deferral back out of an ExitPlanMode tool result, or null. */
export function parseExitPlanModeDeferral(toolResult: string): ExitPlanModeDeferral | null {
  if (!toolResult.includes(DEFERRED_PREFIX)) return null;
  const named = WORKTREE_NAME_PATTERN.exec(toolResult);
  if (named) return { kind: 'worktree', worktreeName: named[1] };
  if (NEW_WORKTREE_PATTERN.test(toolResult)) return { kind: 'worktree', worktreeName: null };
  return { kind: 'session' };
}
