import type { AgentMessage } from '../ai/server/types';
import type { EncryptedMessage } from './collabV3WireTypes';
import { utf8ByteLen } from '../utils/contentBytes';
import { MAX_SYNC_ROW_PLAINTEXT_BYTES, truncateContentForSync, wholeRowElisionMarker } from './syncContentTruncator';
import { inlineDisplayImagesForSync } from './syncDisplayImages';
import { encrypt } from './collabV3Crypto';

export async function encryptSessionMessage(
    message: AgentMessage,
    key: CryptoKey
  ): Promise<EncryptedMessage> {
    // Trim large tool_result payloads before encryption so the SessionRoom
    // doesn't store full Bash/Read/Grep output for every step. Local raw log
    // keeps the unmodified content -- this only changes what crosses the wire.
    const { content: truncatedContent } = truncateContentForSync(
      message.content,
      message.source,
    );
    // Include hidden flag in encrypted content so it syncs to mobile
    const envelope = (body: string, metadata: unknown) =>
      JSON.stringify({ content: body, metadata, hidden: message.hidden ?? false });
    // What the envelope leaves for the escaped content, after metadata and keys.
    const contentRoom = MAX_SYNC_ROW_PLAINTEXT_BYTES - (utf8ByteLen(envelope('', message.metadata)) - 2);
    // display_to_user images are desktop paths; the phone needs the bytes.
    const syncContent = await inlineDisplayImagesForSync(truncatedContent, contentRoom);

    // Every send path encrypts here, so this is the bound the server enforces:
    // a row over it is refused as message_too_large and never reaches the phone.
    let content = envelope(syncContent, message.metadata);
    if (utf8ByteLen(content) > MAX_SYNC_ROW_PLAINTEXT_BYTES) {
      const marker = wholeRowElisionMarker(message.source, utf8ByteLen(message.content));
      content = envelope(marker, message.metadata);
      // Metadata alone past the limit is pathological; the row still reaches the phone.
      if (utf8ByteLen(content) > MAX_SYNC_ROW_PLAINTEXT_BYTES) content = envelope(marker, undefined);
    }


    // Use provider-assigned message ID if available (e.g., SDK uuid)
    // This is the most reliable deduplication method as the provider guarantees uniqueness
    // Fall back to hash-based ID for older messages or non-SDK providers
    let syncId: string;
    if (message.providerMessageId) {
      syncId = message.providerMessageId;
    } else {
      // Generate a STABLE sync ID from message content + timestamp
      // This prevents duplicate messages when the same message is synced multiple times
      // We hash: sessionId + timestamp + first 100 chars of content + direction
      const timestamp = message.createdAt instanceof Date
        ? message.createdAt.getTime()
        : typeof message.createdAt === 'number'
          ? message.createdAt
          : Date.now();
      const contentPreview = message.content.substring(0, 100);
      const hashInput = `${message.sessionId}:${timestamp}:${message.direction}:${contentPreview}`;

      // Use SubtleCrypto to generate a stable hash
      const encoder = new TextEncoder();
      const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(hashInput));
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      syncId = hashArray.slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    const { encrypted, iv } = await encrypt(content, key);
    return {
      id: syncId,
      sequence: 0, // Server assigns sequence
      createdAt: message.createdAt instanceof Date
        ? message.createdAt.getTime()
        : typeof message.createdAt === 'number'
          ? message.createdAt
          : Date.now(),
      source: message.source as EncryptedMessage['source'],
      direction: message.direction as EncryptedMessage['direction'],
      encryptedContent: encrypted,
      iv,
      metadata: {},
    };
  }

