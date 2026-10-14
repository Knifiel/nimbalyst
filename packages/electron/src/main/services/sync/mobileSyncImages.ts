import { promises as fs } from 'fs';
import * as path from 'path';
import { setSyncImageCompressor, setSyncLocalImageLoader } from '@nimbalyst/runtime/sync';
import { compressImageIfNeeded } from '../../mcp/mcpImageCompression';

// Screenshots taken by a desktop session are only viewable on mobile if their
// bytes ride along in the synced message -- there is no desktop -> mobile
// attachment channel. The truncator downscales inline image blocks, and the
// display_to_user inliner reads the files those tool calls reference by path
// (nativeImage and the filesystem live in main, the runtime sync code does not).
//
// The budget is much tighter than the MCP one: every screenshot permanently
// occupies part of a SessionRoom's storage cap on the sync server. 150 KB at
// 1600px still gives real zoom headroom on a phone.
const MOBILE_SYNC_IMAGE_MAX_BYTES = 150 * 1024;
const MOBILE_SYNC_IMAGE_MAX_DIMENSION = 1600;

/** Files larger than this are not read at all; the phone shows the load-failure message. */
const MAX_SOURCE_IMAGE_FILE_BYTES = 30 * 1024 * 1024;

/** Base64 ceiling for one inlined image, matching the truncator's per-block cap. */
const MAX_INLINED_IMAGE_BASE64_BYTES = 220 * 1024;

const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
};

function compressForMobile(data: string, mimeType: string): { data: string; mimeType: string } {
  const { data: out, mimeType: outMime } = compressImageIfNeeded(data, mimeType, {
    maxBytes: MOBILE_SYNC_IMAGE_MAX_BYTES,
    maxDimension: MOBILE_SYNC_IMAGE_MAX_DIMENSION,
  });
  return { data: out, mimeType: outMime };
}

export async function loadImageFileForMobileSync(
  absolutePath: string,
): Promise<{ data: string; mimeType: string } | null> {
  const mimeType = IMAGE_MIME_TYPES[path.extname(absolutePath).toLowerCase()];
  if (!mimeType || !path.isAbsolute(absolutePath)) return null;
  const stat = await fs.stat(absolutePath);
  if (!stat.isFile() || stat.size > MAX_SOURCE_IMAGE_FILE_BYTES) return null;
  const raw = (await fs.readFile(absolutePath)).toString('base64');
  const result = compressForMobile(raw, mimeType);
  return result.data.length <= MAX_INLINED_IMAGE_BASE64_BYTES ? result : null;
}

setSyncImageCompressor(compressForMobile);
setSyncLocalImageLoader(loadImageFileForMobileSync);
