import {
  MAX_SESSION_INLINE_BYTES, MAX_SESSION_PAYLOAD_BYTES, MAX_SESSION_PAYLOAD_PARTS,
  SESSION_PAYLOAD_PLAIN_PART_BYTES, SESSION_PROJECTION_VERSION,
  type SessionPayloadManifest, type SessionPayloadPart, type SessionPayloadReference,
  validSessionPayloadPart,
} from '@nimbalyst/collab-protocol';
import { encrypt, decrypt, base64ToUint8Array, uint8ArrayToBase64 } from './collabV3Crypto';
import { SessionPayloadPublicationError } from './sessionPayloadChannel';

async function digest(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export interface EncodedSessionPayload {
  encryptedContent: string;
  iv: string;
  payload?: SessionPayloadReference;
  parts: SessionPayloadPart[];
}

export async function encodeSessionPayload(messageId: string, content: string, key: CryptoKey): Promise<EncodedSessionPayload> {
  const bytes = new TextEncoder().encode(content);
  if (bytes.length > MAX_SESSION_PAYLOAD_BYTES) throw new SessionPayloadPublicationError('Transcript payload exceeds the lossless sync budget', undefined, false);
  const inline = await encrypt(content, key);
  if (inline.encrypted.length <= MAX_SESSION_INLINE_BYTES) {
    return { encryptedContent: inline.encrypted, iv: inline.iv, parts: [] };
  }
  const count = Math.ceil(bytes.length / SESSION_PAYLOAD_PLAIN_PART_BYTES);
  if (count > MAX_SESSION_PAYLOAD_PARTS) throw new SessionPayloadPublicationError('Transcript payload requires too many sync parts', undefined, false);
  const transferId = crypto.randomUUID().replaceAll('-', '');
  const parts: SessionPayloadPart[] = [];
  for (let index = 0; index < count; index++) {
    const data = uint8ArrayToBase64(bytes.slice(index * SESSION_PAYLOAD_PLAIN_PART_BYTES, (index + 1) * SESSION_PAYLOAD_PLAIN_PART_BYTES));
    const part = await encrypt(JSON.stringify({ messageId, transferId, count, index, data }), key);
    parts.push({ messageId, transferId, count, index, encryptedContent: part.encrypted, iv: part.iv });
  }
  const manifest: SessionPayloadManifest = {
    format: 'session-payload-v1', messageId, transferId, count,
    projectionVersion: SESSION_PROJECTION_VERSION, bytes: bytes.length, sha256: await digest(bytes),
  };
  const encrypted = await encrypt(JSON.stringify(manifest), key);
  return { encryptedContent: encrypted.encrypted, iv: encrypted.iv, payload: { transferId, count }, parts };
}

export async function decodeSessionPayload(
  message: { id: string; encryptedContent: string; iv: string; payload?: SessionPayloadReference },
  key: CryptoKey,
  parts: readonly SessionPayloadPart[],
): Promise<string> {
  const plaintext = await decrypt(message.encryptedContent, message.iv, key);
  if (!message.payload) return plaintext;
  const manifest = JSON.parse(plaintext) as SessionPayloadManifest;
  const { transferId, count } = message.payload;
  if (manifest.format !== 'session-payload-v1' || manifest.messageId !== message.id
    || manifest.transferId !== transferId || manifest.count !== count || manifest.projectionVersion !== SESSION_PROJECTION_VERSION
    || !Number.isInteger(manifest.bytes) || manifest.bytes <= 0 || manifest.bytes > MAX_SESSION_PAYLOAD_BYTES
    || count > MAX_SESSION_PAYLOAD_PARTS || count <= 0 || parts.length !== count) throw new Error('Invalid or incomplete transcript payload');
  const output = new Uint8Array(manifest.bytes);
  let offset = 0;
  const byIndex = new Map(parts.map(part => [part.index, part]));
  for (let index = 0; index < count; index++) {
    const part = byIndex.get(index);
    if (!validSessionPayloadPart(part) || part.messageId !== message.id || part.transferId !== transferId || part.count !== count) {
      throw new Error('Missing or mismatched transcript part');
    }
    const decoded = JSON.parse(await decrypt(part.encryptedContent, part.iv, key));
    if (decoded.messageId !== message.id || decoded.transferId !== transferId || decoded.index !== index || decoded.count !== count
      || typeof decoded.data !== 'string') throw new Error('Transcript part authentication context mismatch');
    const bytes = base64ToUint8Array(decoded.data);
    if (offset + bytes.length > output.length || bytes.length > SESSION_PAYLOAD_PLAIN_PART_BYTES) throw new Error('Invalid transcript part size');
    output.set(bytes, offset);
    offset += bytes.length;
  }
  if (offset !== output.length || await digest(output) !== manifest.sha256) throw new Error('Transcript payload integrity check failed');
  return new TextDecoder('utf-8', { fatal: true }).decode(output);
}
