/**
 * nonRenderingFrames -- the single classification of provider frames that
 * produce no transcript event, ever.
 *
 * Three separate consumers need this answer and used to each keep their own
 * copy:
 *
 *   1. the local storage gate  (`isTransientClaudeCodeChunk`, provider write path)
 *   2. the sync wire gate      (`syncContentTruncator`)
 *   3. the storage backfill    (`toolOutputRetentionPass`'s prune lane)
 *
 * They drifted, and the drift was expensive. The sync copy listed
 * `thinking_tokens` with a written justification -- "live progress ticks, they
 * drive an in-memory indicator only and produce no descriptor on reparse" --
 * and the storage copy did not. On the measured install that one missing entry
 * was 325,585 rows, 121,871 of them written in a single month: 44% of every
 * claude-code row that month, for a counter that reads
 * `{"estimated_tokens":250,"estimated_tokens_delta":100}`. Conversely the
 * storage copy listed `task_updated` and the sync copy did not, so the same
 * frame was dead weight on disk and live on the wire.
 *
 * Everything below is derived from the READ path, which is what makes it safe
 * to delete against. `ClaudeCodeRawParser` handles exactly one system subtype
 * (`permission_denied`); `CodexAppServerRawParser` ignores the delta methods
 * entirely. If you add a branch to either parser, remove the corresponding
 * entry here in the same commit -- a frame that renders must never appear in
 * this file.
 *
 * NOT in scope here: frames that render nothing but are kept on purpose.
 * `system/init` and `system/compact_boundary` produce no transcript event yet
 * stay persisted for forensics (init carries the SDK session id and the
 * tool/MCP context). Those belong to the caller's own policy, not to this
 * module's "never renders" answer.
 */

/**
 * Claude Agent SDK `system` frames whose subtype yields no canonical event.
 *
 * `thinking_tokens` is the expensive one and the reason this module exists:
 * a long turn emits dozens of ticks, each its own row.
 */
export const CLAUDE_CODE_TRANSIENT_SYSTEM_SUBTYPES: ReadonlySet<string> = new Set([
  'hook_started',
  'hook_response',
  'task_started',
  'task_progress',
  'task_notification',
  'task_updated',
  'thinking_tokens',
]);

/** Claude Agent SDK top-level chunk types that are pure runtime side-channels. */
export const CLAUDE_CODE_TRANSIENT_CHUNK_TYPES: ReadonlySet<string> = new Set([
  'tool_progress',
  'tool_use_summary',
  'auth_status',
  'rate_limit_event',
  'prompt_suggestion',
]);

/**
 * Codex app-server delta methods, superseded by the `item/completed` frame for
 * the SAME item id, which carries the final text or the aggregated output.
 *
 * Held apart from the status methods below because the two answer different
 * questions. A status notification renders nothing and is superseded by
 * nothing, so "does it render" settles it. A delta renders nothing only
 * BECAUSE a later frame holds the same content -- and a turn the user cancelled
 * or whose CLI died never wrote that frame, leaving the delta as the only copy
 * of what the assistant said. A destructive path may only act on a delta once
 * it has found the matching `item/completed`; see `rawMessagePrune`.
 *
 * Both carry `params.itemId`, and `item/completed` carries `params.item.id`, so
 * that proof is exact per item rather than per session. They stopped being
 * written when the write-path filter landed; the rows they left behind are what
 * the prune lane clears.
 */
export const CODEX_APP_SERVER_SUPERSEDED_DELTA_METHODS: ReadonlySet<string> = new Set([
  'item/agentMessage/delta',
  'item/commandExecution/outputDelta',
]);

/**
 * Codex app-server notification methods that are pure status: a counter, a
 * lifecycle marker, a rate-limit snapshot. Nothing renders them and nothing
 * supersedes them, because they carry no content to supersede.
 */
export const CODEX_APP_SERVER_STATUS_EVENT_TYPES: ReadonlySet<string> = new Set([
  'thread/tokenUsage/updated',
  'account/rateLimits/updated',
  'thread/status/changed',
  'mcpServer/startupStatus/updated',
  'turn/started',
  'turn/completed',
  'turn/diff/updated',
  'skills/changed',
]);

/**
 * Every codex app-server method that renders nothing, deltas and status alike.
 *
 * The sync wire gate wants exactly this union -- it decides what to put on the
 * wire, which is not destructive and so does not care WHY a frame renders
 * nothing. Only the prune lane needs the distinction.
 */
export const CODEX_APP_SERVER_TRANSIENT_EVENT_TYPES: ReadonlySet<string> = new Set([
  ...CODEX_APP_SERVER_SUPERSEDED_DELTA_METHODS,
  ...CODEX_APP_SERVER_STATUS_EVENT_TYPES,
]);

/**
 * Legacy codex SDK/exec transport events that render nothing. `thread.started`
 * only captures a thread id; `token_count` only feeds a turn_ended descriptor,
 * which the projector drops.
 */
export const CODEX_LEGACY_TRANSIENT_EVENT_TYPES: ReadonlySet<string> = new Set([
  'thread.started',
  'token_count',
]);

/**
 * True when a parsed Claude Agent SDK chunk produces no transcript event.
 *
 * Takes the already-parsed object rather than a JSON string so the live write
 * path -- which holds the chunk anyway -- never pays a parse.
 */
export function isTransientClaudeCodeFrame(chunk: unknown): boolean {
  if (!chunk || typeof chunk !== 'object') return false;
  const c = chunk as { type?: unknown; subtype?: unknown };
  if (c.type === 'system' && typeof c.subtype === 'string') {
    return CLAUDE_CODE_TRANSIENT_SYSTEM_SUBTYPES.has(c.subtype);
  }
  return typeof c.type === 'string' && CLAUDE_CODE_TRANSIENT_CHUNK_TYPES.has(c.type);
}

/**
 * True for a delta frame whose content lives on in a later `item/completed`
 * for the same item -- IF that frame was ever written.
 */
export function isSupersededCodexAppServerDelta(envelope: unknown): boolean {
  return codexAppServerMethod(envelope, CODEX_APP_SERVER_SUPERSEDED_DELTA_METHODS);
}

/** True for a codex app-server frame that is pure status and supersedes nothing. */
export function isStatusCodexAppServerFrame(envelope: unknown): boolean {
  return codexAppServerMethod(envelope, CODEX_APP_SERVER_STATUS_EVENT_TYPES);
}

/**
 * The item a delta frame belongs to, which is the id its `item/completed` will
 * carry as `params.item.id`.
 *
 * Returns null when the field is absent, and the caller must then treat the
 * frame as unproven -- an unidentifiable delta cannot be shown to be superseded
 * by anything.
 */
export function readCodexAppServerDeltaItemId(envelope: unknown): string | null {
  if (!envelope || typeof envelope !== 'object') return null;
  const itemId = (envelope as { params?: { itemId?: unknown } }).params?.itemId;
  return typeof itemId === 'string' && itemId ? itemId : null;
}

function codexAppServerMethod(envelope: unknown, methods: ReadonlySet<string>): boolean {
  if (!envelope || typeof envelope !== 'object') return false;
  const method = (envelope as { method?: unknown }).method;
  return typeof method === 'string' && methods.has(method);
}
