/** #1711: lossless oversized personal transcript payloads. All bodies are E2E encrypted. */
export const SESSION_PROJECTION_VERSION = 1;
export const SESSION_PAYLOAD_VERSION = 1;
export const MAX_SESSION_INLINE_BYTES = 512 * 1024;
export const MAX_SESSION_PAYLOAD_PARTS = 128;
export const SESSION_PAYLOAD_PLAIN_PART_BYTES = 128 * 1024;
export const MAX_SESSION_PAYLOAD_BYTES = 16 * 1024 * 1024;

export interface SessionPayloadReference {
  transferId: string;
  count: number;
}

export interface SessionPayloadPart extends SessionPayloadReference {
  messageId: string;
  index: number;
  encryptedContent: string;
  iv: string;
}

export interface SessionPayloadManifest extends SessionPayloadReference {
  format: 'session-payload-v1';
  messageId: string;
  projectionVersion: 1;
  /** Digest is inside the encrypted manifest, never plaintext routing metadata. */
  sha256: string;
  bytes: number;
}

export type SessionPayloadClientMessage =
  | { type: 'getMessageProjection'; messageId: string }
  | { type: 'appendMessagePart'; part: SessionPayloadPart }
  | { type: 'getMessageParts'; transferId: string; indexes: number[] };

export type SessionPayloadServerMessage =
  | { type: 'messageProjectionState'; messageId: string; revision: number }
  | { type: 'sessionPayloadReady'; version: 1 }
  | { type: 'messagePayloadPart'; part: SessionPayloadPart }
  | { type: 'messagePartAck'; transferId: string; index: number }
  | { type: 'messageAppendAck'; messageId: string; revision: number };

export function validSessionPayloadReference(value: unknown): value is SessionPayloadReference {
  const v = value as Partial<SessionPayloadReference> | null;
  return !!v && typeof v.transferId === 'string' && /^[a-f0-9]{32}$/.test(v.transferId)
    && Number.isInteger(v.count) && v.count! > 0 && v.count! <= MAX_SESSION_PAYLOAD_PARTS;
}

export function validSessionPayloadPart(value: unknown): value is SessionPayloadPart {
  const p = value as SessionPayloadPart;
  return validSessionPayloadReference(p) && typeof p.messageId === 'string' && p.messageId.length > 0
    && p.messageId.length <= 256 && Number.isInteger(p.index) && p.index >= 0 && p.index < p.count
    && typeof p.encryptedContent === 'string' && p.encryptedContent.length > 0
    && p.encryptedContent.length <= MAX_SESSION_INLINE_BYTES
    && typeof p.iv === 'string' && /^[A-Za-z0-9+/]{16}$/.test(p.iv);
}
