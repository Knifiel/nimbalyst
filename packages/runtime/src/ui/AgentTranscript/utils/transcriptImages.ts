/**
 * Every enlargeable image in a transcript, in reading order, so the lightbox
 * can step from one to the next. Built from message data rather than the DOM
 * because the transcript is virtualized: rows scrolled out of view are not
 * mounted, but their images are still part of the sequence.
 */

import type { TranscriptViewMessage } from '../../../ai/server/transcript/TranscriptProjector';
import type { ChatAttachment } from '../../../ai/server/types';
import { localAssetUrl } from '../../../utils/localAssetUrl';

export interface DisplayImageContent {
  path: string;
  /** Base64 bytes attached by desktop on the mobile sync path; the phone cannot read `path`. */
  data?: string;
  mimeType?: string;
}

export type TranscriptImage =
  | { key: string; label: string; kind: 'attachment'; attachment: ChatAttachment }
  | { key: string; label: string; kind: 'screenshot'; message: TranscriptViewMessage }
  | { key: string; label: string; kind: 'display'; image: DisplayImageContent };

export function attachmentImageKey(messageId: number, attachmentId: string): string {
  return `${messageId}:attachment:${attachmentId}`;
}

export function screenshotImageKey(messageId: number): string {
  return `${messageId}:screenshot`;
}

/** `itemIndex` is the position in the tool's `items` array, charts included. */
export function displayImageKey(messageId: number, itemIndex: number): string {
  return `${messageId}:display:${itemIndex}`;
}

/** Full-size src for an attachment; local paths go through `nim-asset://`. */
export function attachmentImageSrc(attachment: ChatAttachment): string {
  const filepath = attachment.filepath;
  if (filepath) {
    if (filepath.startsWith('data:')) return filepath;
    if (filepath.startsWith('file://')) return localAssetUrl(filepath.replace(/^file:\/\//, ''));
    return localAssetUrl(filepath);
  }
  return attachment.thumbnail || '';
}

export function screenshotFileName(message: TranscriptViewMessage): string {
  const args = message.toolCall?.arguments as Record<string, unknown> | undefined;
  const filePath = (args?.file_path || args?.filePath || '') as string;
  return filePath.split('/').pop() || 'screenshot';
}

function bareToolName(toolCall: NonNullable<TranscriptViewMessage['toolCall']>): string {
  if (toolCall.mcpTool) return toolCall.mcpTool;
  const name = toolCall.toolName;
  return name.startsWith('mcp__') ? name.slice(name.lastIndexOf('__') + 2) : name;
}

function collectFromMessage(message: TranscriptViewMessage, out: TranscriptImage[]): void {
  if (message.type === 'user_message') {
    for (const attachment of message.attachments ?? []) {
      if (attachment.type !== 'image') continue;
      out.push({
        key: attachmentImageKey(message.id, attachment.id),
        label: attachment.filename,
        kind: 'attachment',
        attachment: attachment as ChatAttachment,
      });
    }
  }

  const toolCall = message.toolCall;
  if (toolCall) {
    const tool = bareToolName(toolCall);
    if (tool === 'capture_editor_screenshot') {
      if (toolCall.result && !message.isError && !toolCall.isError) {
        out.push({ key: screenshotImageKey(message.id), label: screenshotFileName(message), kind: 'screenshot', message });
      }
    } else if (tool === 'display_to_user') {
      const items = (toolCall.arguments as { items?: unknown })?.items;
      if (Array.isArray(items)) {
        items.forEach((item: { description?: unknown; image?: DisplayImageContent }, index) => {
          if (typeof item?.image?.path !== 'string' || !item.image.path) return;
          out.push({
            key: displayImageKey(message.id, index),
            label: typeof item.description === 'string' ? item.description : item.image.path,
            kind: 'display',
            image: item.image,
          });
        });
      }
    }
  }

  for (const child of message.subagent?.childEvents ?? []) {
    collectFromMessage(child, out);
  }
}

export function collectTranscriptImages(messages: readonly TranscriptViewMessage[]): TranscriptImage[] {
  const out: TranscriptImage[] = [];
  for (const message of messages) collectFromMessage(message, out);
  return out;
}
