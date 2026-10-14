import { SessionPayloadChannel, SessionPayloadPublicationError, type PreparedSessionMessage } from './sessionPayloadChannel';
import type { AgentMessage } from '../ai/server/types';
import type { ClientMessage, ServerMessage, SessionMetadata } from './collabV3WireTypes';
import type { PushChangeOutcome } from './types';

/**
 * Upload transcript rows to a session room over a socket opened for this write
 * alone. Used by the bulk reconcile and by the message outbox when the session
 * has no permanent room socket (for example, because every slot is busy).
 *
 * Returns an outcome for every deliberate stop. Throws, as it always has, when
 * the socket errors or the write times out.
 */
export interface TransientSessionWriteDeps {
  encryptionKey: CryptoKey | undefined;
  isMessageSyncDisabled(sessionId: string): boolean;
  disableMessageSync(sessionId: string, code?: string, message?: string): void;
  isFatalErrorCode(code?: string): boolean;
  isRetained(activityAt: number): boolean;
  withholdWrite(kind: string): boolean;
  /** Bumped by teardown; a write started under an older value must not send anything more. */
  writeGeneration(): number;
  /** Opens the socket and tracks it so teardown can close it; call the returned release when done. */
  openSocket(sessionId: string): Promise<{ ws: WebSocket; release(): void }>;
  shouldSync(message: AgentMessage): boolean;
  encryptMessage(message: AgentMessage, key: CryptoKey): Promise<PreparedSessionMessage>;
  encryptTitle(title: string, key: CryptoKey, sessionId?: string): Promise<{ encryptedTitle: string; titleIv: string }>;
}

export interface TransientSessionMetadata {
  /** Activity of the original session when replaying older retained rows. */
  activityAt?: number;
  title?: string;
  provider?: string;
  model?: string;
  mode?: string;
}

const WRITE_TIMEOUT_MS = 30_000;
const LEGACY_SETTLE_MS = 500;

function activityAtOf(messages: AgentMessage[]): number {
  return messages.reduce((latest, message) => Math.max(
    latest,
    message.createdAt instanceof Date ? message.createdAt.getTime() : typeof message.createdAt === 'number' ? message.createdAt : 0,
  ), 0);
}

export async function writeSessionMessagesOverTransientSocket(
  deps: TransientSessionWriteDeps,
  sessionId: string,
  messages: AgentMessage[],
  metadata?: TransientSessionMetadata,
): Promise<PushChangeOutcome> {
  if (deps.isMessageSyncDisabled(sessionId)) {
    return { published: false, reason: 'message sync is disabled for this session', retryable: false };
  }
  const replayActivityAt = Math.max(activityAtOf(messages), metadata?.activityAt ?? 0);
  if (!deps.isRetained(replayActivityAt)) {
    return { published: false, reason: 'session is outside transcript retention', retryable: false };
  }
  const key = deps.encryptionKey;
  if (!key) {
    console.error('[CollabV3] Cannot sync messages - no encryption key');
    return { published: false, reason: 'no encryption key', retryable: true };
  }
  if (deps.withholdWrite('transcript upload')) {
    return { published: false, reason: 'personal-sync writes are withheld', retryable: true };
  }

  const generation = deps.writeGeneration();
  const shutDown: PushChangeOutcome = { published: false, reason: 'sync was shut down', retryable: false };
  const cancelled = () => deps.writeGeneration() !== generation;
  const { ws, release } = await deps.openSocket(sessionId);
  if (cancelled()) {
    release();
    ws.close();
    return shutDown;
  }

  const payloadChannel = new SessionPayloadChannel(ws);
  return new Promise<PushChangeOutcome>((resolve, reject) => {
    let settled = false;
    const finish = (outcome: PushChangeOutcome | Error, close = true): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      payloadChannel.dispose();
      release();
      if (close) ws.close();
      if (outcome instanceof Error) reject(outcome);
      else resolve(outcome);
    };

    const timeout = setTimeout(() => finish(new Error('Timeout opening transcript write')), WRITE_TIMEOUT_MS);

    ws.onopen = async () => {
      clearTimeout(timeout); // Each publication now has bounded acknowledgement waits.
      try {
        if (cancelled()) {
          finish(shutDown);
          return;
        }
        if (deps.isMessageSyncDisabled(sessionId)) {
          finish({ published: false, reason: 'message sync is disabled for this session', retryable: false });
          return;
        }

        // Retain the original message order. The replay declaration grants
        // only this connection permission to send older rows for current work.
        ws.send(JSON.stringify({ type: 'beginSessionReplay', activityAt: replayActivityAt }));

        if (metadata) {
          const wireMetadata: Partial<SessionMetadata> = {
            provider: metadata.provider,
            model: metadata.model,
            mode: metadata.mode as 'agent' | 'planning' | undefined,
          };
          // Title must be encrypted on the wire. The server stores ciphertext
          // only; sending plaintext here would leak titles into DO SQLite
          // (see also IndexRoom.encrypted_title for the index-side equivalent).
          if (metadata.title) {
            const { encryptedTitle, titleIv } = await deps.encryptTitle(metadata.title, key, `session:${sessionId}`);
            wireMetadata.encryptedTitle = encryptedTitle;
            wireMetadata.titleIv = titleIv;
          }
          if (cancelled()) {
            finish(shutDown);
            return;
          }
          const metadataMsg: ClientMessage = { type: 'updateMetadata', metadata: wireMetadata };
          ws.send(JSON.stringify(metadataMsg));
        }

        for (const message of messages) {
          if (settled || deps.isMessageSyncDisabled(sessionId)) break;
          if (!deps.shouldSync(message)) continue;
          const encrypted = await deps.encryptMessage(message, key);
          if (cancelled()) {
            finish(shutDown);
            return;
          }
          try {
            await payloadChannel.publish(encrypted);
          } catch (err) {
            // One refused row (an unshrinkable screenshot) must not abort the batch.
            if (err instanceof SessionPayloadPublicationError && err.skippable) continue;
            throw err;
          }
        }

        // A legacy server sends no acks (#1391); give the room time to apply before closing.
        if (!payloadChannel.acknowledged) await new Promise(r => setTimeout(r, LEGACY_SETTLE_MS));
        finish(deps.isMessageSyncDisabled(sessionId)
          ? { published: false, reason: 'message sync is disabled for this session', retryable: false }
          : { published: true });
      } catch (err) {
        if (err instanceof SessionPayloadPublicationError) {
          finish({ published: false, reason: err.message, retryable: err.retryable });
          return;
        }
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    };

    ws.onerror = (event) => {
      // WebSocket onerror receives a DOM Event, not an Error object.
      // Extract meaningful info to avoid "Uncaught Error: undefined" dialogs.
      const errorInfo = typeof ErrorEvent !== 'undefined' && event instanceof ErrorEvent
        ? event.message || 'WebSocket error'
        : 'WebSocket connection error';
      finish(new Error(`[CollabV3] ${errorInfo} for session ${sessionId}`), false);
    };

    ws.onmessage = (event) => {
      if (settled) return;
      try {
        const message: ServerMessage = JSON.parse(
          typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data)
        );
        payloadChannel.receive(message);
        if (message.type === 'error' && message.code === 'session_expired') {
          finish({ published: false, reason: 'session expired on the server', retryable: false });
          return;
        }
        if (message.type !== 'error' || !deps.isFatalErrorCode(message.code)) return;
        deps.disableMessageSync(sessionId, message.code, message.message);
        finish({ published: false, reason: message.code ?? 'fatal session-room error', retryable: false });
      } catch {
        // Non-JSON and unrelated server messages do not affect batch sync.
      }
    };

    ws.onclose = () => {
      finish(cancelled() ? shutDown : { published: false, reason: 'socket closed before the write finished', retryable: true }, false);
    };
  });
}
