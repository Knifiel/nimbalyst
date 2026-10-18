/**
 * `display_to_user` images reference a file on the desktop by path. The
 * desktop transcript reads that file; the phone cannot, so on the mobile sync
 * path the image bytes ride along inside the tool call's own arguments
 * (`items[].image.data` / `.mimeType`). The local raw log is untouched.
 *
 * Reading and downscaling happen in the host (Electron's nativeImage lives in
 * main), which registers a loader here. Without a loader the content passes
 * through unchanged and the widget shows its own load-failure message.
 */

import { utf8ByteLen } from '../utils/contentBytes';
import { MAX_SYNC_ROW_CONTENT_BYTES } from './syncContentTruncator';

export type SyncLocalImageLoader = (
  absolutePath: string,
) => Promise<{ data: string; mimeType: string } | null>;

let localImageLoader: SyncLocalImageLoader | null = null;

export function setSyncLocalImageLoader(loader: SyncLocalImageLoader | null): void {
  localImageLoader = loader;
}

/**
 * Inlined bytes share the row's inline limit with the rest of the row. A
 * gallery of large screenshots past it keeps its remaining items path-only
 * rather than pushing the row into the whole-row clamp or a server refusal.
 * Base64 needs no JSON escaping; the reserve covers each item's added keys.
 */
const PER_ITEM_RESERVE_BYTES = 256;

const DISPLAY_TOOL_NAME = /(^|__)display_to_user$/;

type ToolArguments = { items?: unknown };

/** Find every display_to_user argument object in a Claude-shaped or Codex-shaped row. */
function collectDisplayToolArguments(parsed: unknown): ToolArguments[] {
  if (!parsed || typeof parsed !== 'object') return [];
  const found: ToolArguments[] = [];
  const record = parsed as Record<string, unknown>;

  const message = record.message as { content?: unknown } | undefined;
  if (message && Array.isArray(message.content)) {
    for (const block of message.content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as { type?: unknown; name?: unknown; input?: unknown };
      if (b.type === 'tool_use' && typeof b.name === 'string' && DISPLAY_TOOL_NAME.test(b.name)
        && b.input && typeof b.input === 'object') {
        found.push(b.input as ToolArguments);
      }
    }
  }

  const params = record.params as { item?: unknown } | undefined;
  const item = (record.item ?? params?.item) as
    | { type?: unknown; tool?: unknown; arguments?: unknown }
    | undefined;
  if (item && typeof item === 'object'
    && (item.type === 'mcpToolCall' || item.type === 'mcp_tool_call')
    && typeof item.tool === 'string' && DISPLAY_TOOL_NAME.test(item.tool)
    && item.arguments && typeof item.arguments === 'object') {
    found.push(item.arguments as ToolArguments);
  }

  return found;
}

/**
 * Attach image bytes to display_to_user items in a sync-bound row. Returns the
 * input string unchanged when there is nothing to inline. `maxContentBytes`
 * bounds the result as JSON-escaped into the encrypted envelope; the caller
 * passes what the envelope leaves after the row's metadata.
 */
export async function inlineDisplayImagesForSync(
  content: string,
  maxContentBytes: number = MAX_SYNC_ROW_CONTENT_BYTES,
): Promise<string> {
  if (!localImageLoader || !content.includes('display_to_user')) return content;

  let parsed: unknown;
  try { parsed = JSON.parse(content); }
  catch { return content; }

  let budget = maxContentBytes - utf8ByteLen(JSON.stringify(content));
  let modified = false;
  for (const args of collectDisplayToolArguments(parsed)) {
    if (!Array.isArray(args.items)) continue;
    for (const item of args.items) {
      const image = (item as { image?: unknown } | null)?.image as
        | { path?: unknown; data?: unknown; mimeType?: unknown }
        | undefined;
      if (!image || typeof image.path !== 'string' || typeof image.data === 'string') continue;
      let loaded: { data: string; mimeType: string } | null = null;
      try {
        loaded = await localImageLoader(image.path);
      } catch (error) {
        // A missing or unreadable file degrades to the widget's load-failure
        // message on the phone; it must not block the rest of the row.
        console.warn('[SyncDisplayImages] Failed to load display image for sync:', image.path, error);
      }
      const cost = loaded ? loaded.data.length + PER_ITEM_RESERVE_BYTES : 0;
      if (!loaded || cost > budget) continue;
      image.data = loaded.data;
      image.mimeType = loaded.mimeType;
      budget -= cost;
      modified = true;
    }
  }

  return modified ? JSON.stringify(parsed) : content;
}
