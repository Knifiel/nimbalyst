// Decision helpers for reading the SDK's `prompt_suggestion` frame.
//
// With `promptSuggestions: true` the SDK emits one `prompt_suggestion` message
// per turn AFTER the `result` message, and consumers must keep iterating to
// receive it (sdk.d.ts, `promptSuggestions`). The streaming loop used to break
// on `result`, so the frame was never read. After `complete` the loop now keeps
// reading for a short silence window. The host has already ended the session at
// `complete`, so a follow-up prompt can arrive while we wait; it adopts the live
// query through the drain handoff (drainHandoff.ts) instead of aborting it.
//
// Pure functions so the wait/adopt rules are testable without the SDK stream.

/**
 * How long after `result` to wait for the frame. An absolute deadline, not a
 * silence window: late chunks of any other kind must not extend it. Turns where
 * the CLI suppresses a suggestion (first turn, plan mode, near the usage limit)
 * send nothing, so this is also the longest a quiet turn lingers before teardown.
 */
export const PROMPT_SUGGESTION_WAIT_MS = 8_000;

/**
 * Whether to ask the CLI for a suggestion this turn. Only when a person sent the prompt: a turn
 * driven by an agent or automation has nobody at the input, and the CLI bills the extra request
 * whether or not we read the frame, so this gates the SDK option itself.
 */
export function wantsPromptSuggestion(
  enabled: boolean,
  documentContext: { promptProvenance?: { actor?: string } } | undefined,
): boolean {
  return enabled && documentContext?.promptProvenance?.actor === 'human';
}

/** Time left before the suggestion deadline; zero once it has passed. */
export function promptSuggestionWaitRemainingMs(deadline: number, now: number): number {
  return Math.max(0, deadline - now);
}

export interface AwaitPromptSuggestionFacts {
  /** The Agent Features toggle; the SDK option is only set when this is true. */
  enabled: boolean;
  hasSessionId: boolean;
  /** Background sub-agents already keep the loop open through the drain. */
  willDrainSubagents: boolean;
  /** The CLI never suggests after an API error. */
  resultIsError: boolean;
  /** The CLI suppresses suggestions in plan mode. */
  planMode: boolean;
  /** The CLI suppresses suggestions on the conversation's first turn. */
  firstTurn: boolean;
  wasInterrupted: boolean;
}

/** Whether to keep reading past `result` instead of breaking out of the loop. */
export function shouldAwaitPromptSuggestion(facts: AwaitPromptSuggestionFacts): boolean {
  return facts.enabled
    && facts.hasSessionId
    && !facts.willDrainSubagents
    && !facts.resultIsError
    && !facts.planMode
    && !facts.firstTurn
    && !facts.wasInterrupted;
}

export interface AdoptAwaitingSuggestionFacts {
  awaiting: boolean;
  hasLeadQuery: boolean;
  promptStreamOpen: boolean;
  wasInterrupted: boolean;
  hasPendingUserInteraction: boolean;
  hasTeammateWork: boolean;
  hasPendingContinuation: boolean;
  handoffInProgress: boolean;
}

/**
 * A follow-up may take over the live query while the turn only waits for the
 * suggestion. Nothing else is running on it, so the conditions are the plain
 * subset of `canAdoptDrainingQuery` minus the background-task requirements.
 */
export function canAdoptAwaitingSuggestionQuery(facts: AdoptAwaitingSuggestionFacts): boolean {
  return facts.awaiting
    && facts.hasLeadQuery
    && facts.promptStreamOpen
    && !facts.wasInterrupted
    && !facts.hasPendingUserInteraction
    && !facts.hasTeammateWork
    && !facts.hasPendingContinuation
    && !facts.handoffInProgress;
}

/** The suggestion text of a `prompt_suggestion` frame, or null for any other chunk or an empty one. */
export function extractPromptSuggestion(chunk: unknown): string | null {
  if (!chunk || typeof chunk !== 'object') return null;
  const c = chunk as { type?: unknown; suggestion?: unknown };
  if (c.type !== 'prompt_suggestion' || typeof c.suggestion !== 'string') return null;
  const text = c.suggestion.trim();
  return text.length > 0 ? text : null;
}
