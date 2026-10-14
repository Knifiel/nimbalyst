import type { SessionPayloadPart, SessionPayloadServerMessage } from '@nimbalyst/collab-protocol';
import type { EncryptedMessage } from './collabV3WireTypes';

export type PreparedSessionMessage = EncryptedMessage & { parts?: SessionPayloadPart[] };

/**
 * Server error codes that answer a transcript publication. Publications are
 * serialized per socket, so one of these belongs to the publication in flight.
 * Any other error (a rejected metadata update, say) leaves it alone.
 */
const PUBLICATION_ERROR_CODES = new Set([
  'session_expired', 'invalid_message', 'invalid_projection', 'message_too_large',
  'message_metadata_too_large', 'message_limit_exceeded', 'storage_limit_exceeded',
  'update_required', 'parse_error', 'unknown_message_type',
]);
/** The same row fails the same way on retry; `parse_error` is a refused part (budget, shape). */
const PERMANENT_ERROR_CODES = new Set([
  'session_expired', 'invalid_message', 'invalid_projection', 'message_too_large',
  'message_metadata_too_large', 'message_limit_exceeded', 'update_required', 'parse_error',
]);
/** One refused row must not abort the rest of a batch (matches CollabV3Sync's skippable codes). */
const SKIPPABLE_ERROR_CODES = new Set(['message_too_large', 'storage_limit_exceeded']);

export class SessionPayloadPublicationError extends Error {
  constructor(message: string, readonly code?: string, readonly retryable = true) {
    super(message);
    this.name = 'SessionPayloadPublicationError';
  }
  get skippable(): boolean { return this.code !== undefined && SKIPPABLE_ERROR_CODES.has(this.code); }
}

export function publicationErrorFromServer(code: string | undefined, message: unknown): SessionPayloadPublicationError {
  return new SessionPayloadPublicationError(
    typeof message === 'string' ? message : 'Transcript publication rejected',
    code,
    code === undefined || !PERMANENT_ERROR_CODES.has(code),
  );
}

type Waiter = { resolve(): void; reject(error: Error): void; timeout: ReturnType<typeof setTimeout> };

/**
 * Acknowledged transcript publication over one socket lifetime; close/error
 * rejects every waiter.
 *
 * Capability: a server that understands the payload protocol sends
 * `sessionPayloadReady` as its first frame. Without it, rows go out with the
 * legacy fire-and-forget `appendMessage`, so a desktop build that reaches users
 * before the server deploy keeps syncing everything that fits inline.
 */
export class SessionPayloadChannel {
  private failure?: Error;
  private supported?: boolean;
  private revisions = new Map<string, number>();
  private tail = Promise.resolve();
  private pending = new Map<string, Waiter>();

  constructor(private readonly ws: WebSocket) {}

  /** False when the server never confirmed the protocol, so nothing was acknowledged. */
  get acknowledged(): boolean { return this.supported === true; }

  receive(message: SessionPayloadServerMessage | { type: string; code?: string; message?: unknown }): void {
    if (message.type === 'sessionPayloadReady') { this.supported = true; return; }
    if (message.type === 'error') {
      const { code, message: text } = message as { code?: string; message?: unknown };
      if (code === 'unknown_message_type' && this.supported === undefined) {
        // Legacy server refused the capability probe.
        this.supported = false;
        this.settle(this.pendingProbe(), undefined);
        return;
      }
      if (code !== undefined && PUBLICATION_ERROR_CODES.has(code)) this.rejectAll(publicationErrorFromServer(code, text));
      return;
    }
    const reply = message as SessionPayloadServerMessage;
    // The hello precedes every reply, so any unrelated frame first means a
    // legacy server; a payload-protocol reply proves support either way.
    if (this.supported === undefined) {
      this.supported = ['messageProjectionState', 'messagePartAck', 'messageAppendAck', 'messagePayloadPart'].includes(reply.type);
    }
    if (reply.type === 'messageProjectionState') {
      this.revisions.set(reply.messageId, reply.revision);
      this.settle(`projection:${reply.messageId}`, undefined);
    } else if (reply.type === 'messagePartAck') this.settle(`part:${reply.transferId}:${reply.index}`, undefined);
    else if (reply.type === 'messageAppendAck') this.settle(`message:${reply.messageId}`, undefined);
  }

  publish(prepared: PreparedSessionMessage): Promise<void> {
    const result = this.tail.then(() => this.publishOne(prepared));
    this.tail = result.catch(() => {});
    return result;
  }

  dispose(): void {
    this.failure = new SessionPayloadPublicationError('Transcript payload channel closed');
    this.rejectAll(this.failure);
  }

  private pendingProbe(): string | undefined {
    return [...this.pending.keys()].find(id => id.startsWith('projection:'));
  }

  private settle(id: string | undefined, error: Error | undefined): void {
    const waiter = id ? this.pending.get(id) : undefined;
    if (!waiter || !id) return;
    clearTimeout(waiter.timeout);
    this.pending.delete(id);
    if (error) waiter.reject(error); else waiter.resolve();
  }

  private wait(id: string, send?: () => void): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending.has(id)) return Promise.reject(new Error('Concurrent transcript publication for the same identity'));
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new SessionPayloadPublicationError('Transcript payload acknowledgement timed out'));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timeout });
      try { send?.(); } catch (error) {
        clearTimeout(timeout); this.pending.delete(id); reject(error);
      }
    });
  }

  private requestRevision(messageId: string): Promise<void> {
    return this.wait(`projection:${messageId}`, () => this.ws.send(JSON.stringify({ type: 'getMessageProjection', messageId })));
  }

  private async publishOne(prepared: PreparedSessionMessage): Promise<void> {
    // Only the first publication on a socket that has seen no frame yet pays
    // for a probe; it doubles as the revision lookup for that row.
    if (this.supported === undefined) await this.requestRevision(prepared.id);
    const { parts = [], ...message } = prepared;
    if (!this.supported) {
      if (parts.length) {
        throw new SessionPayloadPublicationError('The sync server does not accept large transcript rows yet');
      }
      const { projectionVersion: _version, payload: _payload, revision: _revision, ...legacy } = message;
      this.ws.send(JSON.stringify({ type: 'appendMessage', message: legacy }));
      return;
    }
    for (const part of parts) {
      await this.wait(`part:${part.transferId}:${part.index}`, () => this.ws.send(JSON.stringify({ type: 'appendMessagePart', part })));
    }
    const append = (expectedRevision: number | undefined) => this.wait(`message:${message.id}`,
      () => this.ws.send(JSON.stringify({ type: 'appendMessage', message, expectedRevision })));
    const known = this.revisions.get(message.id);
    this.revisions.delete(message.id);
    try {
      // New rows need no revision; the server demands one only to replace a v1 row.
      await append(known);
    } catch (error) {
      if (known !== undefined || !(error instanceof SessionPayloadPublicationError) || error.code !== 'invalid_projection') throw error;
      await this.requestRevision(message.id);
      const revision = this.revisions.get(message.id);
      this.revisions.delete(message.id);
      await append(revision);
    }
  }

  private rejectAll(error: Error): void {
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timeout); waiter.reject(error); }
    this.pending.clear();
  }
}
