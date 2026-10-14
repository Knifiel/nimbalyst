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

export type SyncLocalImageLoader = (
  absolutePath: string,
) => Promise<{ data: string; mimeType: string } | null>;

let localImageLoader: SyncLocalImageLoader | null = null;

export function setSyncLocalImageLoader(loader: SyncLocalImageLoader | null): void {
  localImageLoader = loader;
}

/**
 * Ceiling on base64 bytes inlined into one synced row. A gallery of large
 * screenshots past this keeps its remaining items path-only rather than
 * pushing the row past what a SessionRoom should store per message.
 */
const MAX_INLINED_BASE64_BYTES_PER_ROW = 600 * 1024;

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
 * input string unchanged when there is nothing to inline.
 */
export async function inlineDisplayImagesForSync(content: string): Promise<string> {
  if (!localImageLoader || !content.includes('display_to_user')) return content;

  let parsed: unknown;
  try { parsed = JSON.parse(content); }
  catch { return content; }

  let budget = MAX_INLINED_BASE64_BYTES_PER_ROW;
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
      if (!loaded || loaded.data.length > budget) continue;
      image.data = loaded.data;
      image.mimeType = loaded.mimeType;
      budget -= loaded.data.length;
      modified = true;
    }
  }

  return modified ? JSON.stringify(parsed) : content;
}
