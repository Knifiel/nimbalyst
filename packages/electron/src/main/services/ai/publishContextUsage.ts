import { warnIfUnpublished } from '@nimbalyst/runtime/sync/pushOutcome';
import type { SyncProvider } from '@nimbalyst/runtime/sync/types';
import { logger } from '../../utils/logger';

/**
 * Sends a session's context-window usage to the user's phones. Providers with
 * an index socket relay it without a stored write (liveSessionContext.ts); the
 * turn-end index update persists the last value. Failures are logged, never
 * thrown: context usage is display-only and the next step sends a fresh value.
 */
export async function publishContextUsage(
  syncProvider: SyncProvider,
  sessionId: string,
  currentContext: { tokens: number; contextWindow: number },
): Promise<void> {
  try {
    const outcome = syncProvider.publishLiveContext
      ? await syncProvider.publishLiveContext(sessionId, currentContext)
      : await syncProvider.pushChange(sessionId, { type: 'metadata_updated', metadata: { currentContext } });
    warnIfUnpublished(message => logger.main.warn(message), sessionId, '[AIService] Failed to publish context usage', outcome);
  } catch (error) {
    logger.main.warn(`[AIService] Failed to publish context usage for session ${sessionId}:`, error);
  }
}
