import type { AgentMessage } from '../ai/server/types';
import type { PushChangeOutcome, SyncProvider } from './types';
import { shouldSyncMessageForSessionRoom } from './syncContentTruncator';
import { SESSION_PROJECTION_VERSION } from '@nimbalyst/collab-protocol';

/** Local-only durable storage supplied by the host; never publish these source fingerprints. */
export interface ProjectionRepairCheckpoints {
  load(sessionId: string): Promise<{ version: number; completed: string[] } | undefined>;
  save(sessionId: string, value: { version: number; completed: string[] }): Promise<void>;
}

/**
 * Explicit, opt-in repair of one retained session from its ORIGINAL desktop rows.
 * No startup caller: an operator must select a session after server/readers roll out.
 * The provider enforces retention and acknowledges each publication. A checkpoint
 * failure is safe to retry: IDs stay stable, and no phone rows are deleted.
 */
export async function repairSessionProjection(
  sessionId: string,
  sourceRows: readonly AgentMessage[],
  provider: Pick<SyncProvider, 'sendSessionMessages'>,
  checkpoints: ProjectionRepairCheckpoints,
  batchSize = 25,
): Promise<PushChangeOutcome & { repaired: number }> {
  if (!sourceRows.length) return { published: false, retryable: false, reason: 'Original desktop rows are unavailable', repaired: 0 };
  if (!provider.sendSessionMessages) return { published: false, retryable: false, reason: 'Provider has no acknowledged transcript writer', repaired: 0 };
  if (sourceRows.some(row => row.sessionId !== sessionId)) throw new Error('Repair source contains another session');
  const previous = await checkpoints.load(sessionId);
  const completed = new Set(previous?.version === SESSION_PROJECTION_VERSION ? previous.completed : []);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) throw new Error('Invalid repair batch size');
  // reduce, not spread: a long session would overflow the argument stack.
  const activityAt = sourceRows.reduce((latest, row) =>
    Math.max(latest, row.createdAt instanceof Date ? row.createdAt.getTime() : Number(row.createdAt)), -Infinity);
  let repaired = 0;
  let pending: Array<{ row: AgentMessage; fingerprint: string }> = [];
  const publish = async (): Promise<PushChangeOutcome> => {
    const outcome = await provider.sendSessionMessages!(sessionId, pending.map(entry => entry.row), { activityAt });
    if (outcome.published) {
      for (const entry of pending) completed.add(entry.fingerprint);
      await checkpoints.save(sessionId, { version: SESSION_PROJECTION_VERSION, completed: [...completed] });
      repaired += pending.length;
      pending = [];
    }
    return outcome;
  };
  for (const row of sourceRows) {
    if (!shouldSyncMessageForSessionRoom(row.source, row.metadata, row.content, row.hidden)) continue;
    // Include the entire source: a changed raw row must not inherit an old checkpoint.
    const bytes = new TextEncoder().encode(JSON.stringify(row));
    const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (completed.has(fingerprint)) continue;
    pending.push({ row, fingerprint });
    if (pending.length === batchSize) {
      const outcome = await publish();
      if (!outcome.published) return { ...outcome, repaired };
    }
  }
  if (pending.length) {
    const outcome = await publish();
    if (!outcome.published) return { ...outcome, repaired };
  }
  return { published: true, repaired };
}
