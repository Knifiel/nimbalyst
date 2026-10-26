// NIM-2208: a per-session count of interactive prompts that are RIGHT NOW
// blocking a turn, used to decide whether a persisted
// `ai_sessions.metadata.hasPendingPrompt` bit is stale.
//
// The bit is written by every prompt type that blocks on user input, but it was
// only ever cleared by an explicit answer/cancel or a live terminal turn event.
// A process killed by app exit emits neither, so the "awaiting input" indicator
// in AgentSessionsPopover stuck for weeks on sessions whose process was long
// gone. This registry is the "is anything actually blocked?" signal the reconcile
// needs.
//
// Deliberately SEPARATE from the NIM-1981 waiter registry in
// `interactivePromptFallback.ts`, which must keep counting RequestUserInput
// waiters only: `shouldSettleFromSessionFallback` reads "count <= 1" as "sole
// pending prompt for this session, so an unmatched response id is unambiguous".
// Folding the other prompt types into that counter would push it past 1 and
// reject a correct answer, hanging the turn.
//
// Note this covers the MCP-handler path only. Provider-driven prompts
// (ExitPlanMode and friends in `MessageStreamingHandler`) set the bit without
// registering an MCP waiter, so the reconcile pairs this with a
// session-is-tracked-in-memory check rather than trusting it alone.

import type { InteractivePromptKind } from './interactivePromptAbandonment';

/** Per-session count of interactive prompts currently blocking a turn. */
const liveInteractivePrompts = new Map<string, number>();

/** Record that an interactive prompt has begun blocking a session's turn. */
export function noteLiveInteractivePrompt(sessionKey: string): void {
  if (!sessionKey) return;
  liveInteractivePrompts.set(sessionKey, (liveInteractivePrompts.get(sessionKey) ?? 0) + 1);
}

/** Record that an interactive prompt has settled (answered, cancelled, or timed out). */
export function clearLiveInteractivePrompt(sessionKey: string): void {
  if (!sessionKey) return;
  const next = (liveInteractivePrompts.get(sessionKey) ?? 0) - 1;
  if (next <= 0) {
    liveInteractivePrompts.delete(sessionKey);
  } else {
    liveInteractivePrompts.set(sessionKey, next);
  }
}

/** How many interactive prompts are currently blocking this session's turn. */
export function countLiveInteractivePrompts(sessionKey: string): number {
  return liveInteractivePrompts.get(sessionKey) ?? 0;
}

/** Whether any interactive prompt is currently blocking this session's turn. */
export function hasLiveInteractivePrompt(sessionKey: string): boolean {
  return countLiveInteractivePrompts(sessionKey) > 0;
}

/**
 * A live prompt that another part of the app can close for good. Registering
 * one also counts it as live (above).
 */
export interface LiveInteractivePrompt {
  kind: InteractivePromptKind;
  promptId: string;
  /**
   * Settle the waiter terminally and write the result that closes its card.
   * Returns false when the prompt is already settling, or an answer owns it
   * (a commit already executing). Must start synchronously: a client abort
   * that arrives later has to find the waiter already settled.
   */
  settleTerminally(reason: 'superseded'): boolean | Promise<boolean>;
}

const liveWaiters = new Map<string, Set<LiveInteractivePrompt>>();

/** Count `prompt` as live and make it settleable; the returned function undoes both (idempotent). */
export function registerLiveInteractivePrompt(sessionKey: string, prompt: LiveInteractivePrompt): () => void {
  if (!sessionKey) return () => {};
  noteLiveInteractivePrompt(sessionKey);
  const set = liveWaiters.get(sessionKey) ?? new Set<LiveInteractivePrompt>();
  set.add(prompt);
  liveWaiters.set(sessionKey, set);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    set.delete(prompt);
    if (set.size === 0 && liveWaiters.get(sessionKey) === set) liveWaiters.delete(sessionKey);
    clearLiveInteractivePrompt(sessionKey);
  };
}

/**
 * Close a session's live prompts for good, as `reason`. Every settle starts
 * before this returns its promise. Resolves with the ids that closed.
 */
export async function settleLiveInteractivePrompts(
  sessionKey: string,
  reason: 'superseded',
  match?: (prompt: LiveInteractivePrompt) => boolean,
): Promise<string[]> {
  const prompts = [...(liveWaiters.get(sessionKey) ?? [])].filter(prompt => !match || match(prompt));
  const settles = prompts.map(prompt => {
    try {
      return Promise.resolve(prompt.settleTerminally(reason)).catch(error => settleFailed(prompt, error));
    } catch (error) {
      return Promise.resolve(settleFailed(prompt, error));
    }
  });
  const closed = await Promise.all(settles);
  return prompts.filter((_, index) => closed[index]).map(prompt => prompt.promptId);
}

function settleFailed(prompt: LiveInteractivePrompt, error: unknown): false {
  console.warn(`[interactivePromptLiveness] Could not settle ${prompt.kind} ${prompt.promptId}:`, error);
  return false;
}
