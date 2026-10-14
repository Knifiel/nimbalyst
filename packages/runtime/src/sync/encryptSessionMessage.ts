import { SESSION_PROJECTION_VERSION } from '@nimbalyst/collab-protocol';
import type { AgentMessage } from '../ai/server/types';
import type { EncryptedMessage } from './collabV3WireTypes';
import type { PreparedSessionMessage } from './sessionPayloadChannel';
import { truncateContentForSync } from './syncContentTruncator';
import { inlineDisplayImagesForSync } from './syncDisplayImages';
import { encodeSessionPayload } from './sessionPayloadCodec';

export async function encryptSessionMessage(
    message: AgentMessage,
    key: CryptoKey
  ): Promise<PreparedSessionMessage> {
    // Trim large tool_result payloads before encryption so the SessionRoom
    // doesn't store full Bash/Read/Grep output for every step. Local raw log
    // keeps the unmodified content -- this only changes what crosses the wire.
    const { content: truncatedContent } = truncateContentForSync(
      message.content,
      message.source,
    );
    // display_to_user images are desktop paths; the phone needs the bytes.
    const syncContent = await inlineDisplayImagesForSync(truncatedContent);

    // Include hidden flag in encrypted content so it syncs to mobile
    const content = JSON.stringify({
      content: syncContent,
      metadata: message.metadata,
      hidden: message.hidden ?? false,
    });


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

    const encoded = await encodeSessionPayload(syncId, content, key);
    return {
      ...encoded,
      projectionVersion: SESSION_PROJECTION_VERSION,
      id: syncId,
      sequence: 0, // Server assigns sequence
      createdAt: message.createdAt instanceof Date
        ? message.createdAt.getTime()
        : typeof message.createdAt === 'number'
          ? message.createdAt
          : Date.now(),
      source: message.source as EncryptedMessage['source'],
      direction: message.direction as EncryptedMessage['direction'],
      metadata: {},
    };
  }

