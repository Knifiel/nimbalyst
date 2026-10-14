/**
 * Publishes a session's live context-window usage without a stored write.
 *
 * Context usage changes on every assistant step. Publishing it as index
 * metadata made each step a full `indexUpdate` (a row rewrite plus a
 * replication-journal entry on the server) and, with a session room open, a
 * second `updateMetadata` write. Instead the value is merged into the local
 * index cache, so the next persisted write (at the latest the turn-end
 * `isExecuting: false` update) carries it, and sent as a relay-only
 * `sessionContextUpdate` frame that the server forwards to the user's other
 * devices without storing.
 *
 * A session the index cache does not know yet falls back to the stored path;
 * there is no row on the phone for a live value to land on.
 *
 * The cache is not a safe place to keep the value: an index read or another
 * device's echo replaces the entry with the older stored row mid-turn, and the
 * turn-end write would persist that. So the publisher keeps the latest value
 * this desktop produced and `overlay` applies it to every outgoing index
 * build. This desktop runs the turn, so its latest value is always the
 * correct one.
 */

import { mergeSessionIndexMetadata, type CachedSessionIndex } from './sessionIndexMetadata';
import { encryptStable } from './stableCiphertext';
import type { PushChangeOutcome } from './types';

export type CurrentContext = { tokens: number; contextWindow: number };

export interface LiveContextDeps {
  /** The per-session publish queue, so a concurrent index write cannot drop the merged value. */
  serialize<T>(sessionId: string, task: () => Promise<T>): Promise<T>;
  getCached(sessionId: string): CachedSessionIndex | undefined;
  setCached(sessionId: string, entry: CachedSessionIndex): void;
  encryptionKey(): CryptoKey | null | undefined;
  /** Sends on the open index socket; false when there is none. */
  send(frame: string): boolean;
  /** The stored path, for sessions the index cache does not hold. */
  fallback(sessionId: string, currentContext: CurrentContext): Promise<PushChangeOutcome>;
  now?: () => number;
}

const MAX_TRACKED_SESSIONS = 1000;

export function createLiveContextPublisher(deps: LiveContextDeps) {
  const now = deps.now ?? Date.now;
  const latest = new Map<string, CurrentContext>();

  function overlay<T extends { sessionId: string; currentContext?: CurrentContext }>(entry: T): T {
    const current = latest.get(entry.sessionId);
    return current ? { ...entry, currentContext: current } : entry;
  }

  async function publish(sessionId: string, currentContext: CurrentContext): Promise<PushChangeOutcome> {
    latest.delete(sessionId);
    latest.set(sessionId, currentContext);
    if (latest.size > MAX_TRACKED_SESSIONS) latest.delete(latest.keys().next().value!);
    const key = deps.encryptionKey();
    if (!key || !deps.getCached(sessionId)) return deps.fallback(sessionId, currentContext);
    return deps.serialize(sessionId, async () => {
      const cached = deps.getCached(sessionId);
      if (!cached) return { published: false, reason: 'session left the index cache', retryable: true };
      deps.setCached(sessionId, mergeSessionIndexMetadata(cached, { currentContext }));
      const { encrypted, iv } = await encryptStable(`liveContext:${sessionId}`, JSON.stringify({ currentContext }), key);
      const sent = deps.send(JSON.stringify({
        type: 'sessionContextUpdate',
        update: { sessionId, encryptedContext: encrypted, contextIv: iv, at: now() },
      }));
      // Unsent is not lost: `overlay` puts it in the next index write.
      return sent ? { published: true } : { published: false, reason: 'index socket not open', retryable: true };
    });
  }

  return { publish, overlay };
}
