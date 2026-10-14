import { warnIfUnpublished } from '@nimbalyst/runtime/sync/pushOutcome';
import { logger } from '../../utils/logger';
import type { getSyncProvider } from '../SyncManager';

type SyncProvider = NonNullable<ReturnType<typeof getSyncProvider>>;

/**
 * Tells the phone the session is no longer executing. Failures are logged, not
 * thrown: the next turn's start/end publish overwrites this metadata, and a turn
 * must not fail because the phone could not be told it ended.
 */
export async function publishTurnNotExecuting(syncProvider: SyncProvider, sessionId: string): Promise<void> {
  try {
    const outcome = await syncProvider.pushChange(sessionId, {
      type: 'metadata_updated',
      metadata: { isExecuting: false, hasPendingPrompt: false, updatedAt: Date.now() },
    });
    warnIfUnpublished(message => logger.main.warn(message), sessionId, '[AIService] Failed to publish sync change', outcome);
  } catch (error) {
    logger.main.warn(`[AIService] Failed to publish sync change for session ${sessionId}:`, error);
  }
}
