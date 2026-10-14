/**
 * A file dropped or pasted into a Local wiki page is stored in the page's own
 * `.assets/` folder (see FORMAT.md "Attachments"), so it moves with the page.
 * Images the renderer can show become image nodes; anything else is a link.
 */
import type { UploadedEditorAsset } from '@nimbalyst/runtime/editor/EditorConfig';
import { getPersonalCollabHost } from '../store/atoms/collabDocuments';

/** HEIC and other formats Chromium cannot decode are attached as files. */
const INLINE_IMAGE_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/avif', 'image/bmp',
]);

export async function uploadLocalWikiAttachment(workspacePath: string, pageFilePath: string, file: File): Promise<UploadedEditorAsset> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const name = file.name || (file.type.startsWith('image/') ? `image.${file.type.slice(6).replace(/\+.*$/, '')}` : 'attachment');
  const { link } = await window.electronAPI.invoke('local-wiki:store-attachment', workspacePath, pageFilePath, name, bytes) as { link: string };
  return INLINE_IMAGE_TYPES.has(file.type)
    ? { kind: 'image', src: link, altText: name }
    : { kind: 'file', src: link, name };
}

/** The editor upload hook for `filePath` when it is a Local wiki page; undefined for any other file. */
export function localWikiUploadAssetFor(
  workspacePath: string | undefined,
  filePath: string,
): ((file: File) => Promise<UploadedEditorAsset>) | undefined {
  const source = workspacePath ? getPersonalCollabHost(workspacePath).source() : null;
  const documentId = source?.documentIdForFile(filePath) ?? null;
  // console.log('[LocalWikiAttachments] upload hook decision', {
  //   workspacePath,
  //   filePath,
  //   documentId,
  //   knownPages: source?.filePathsById().size ?? 0,
  // });
  if (!workspacePath || !documentId) return undefined;
  return (file) => uploadLocalWikiAttachment(workspacePath, filePath, file);
}
