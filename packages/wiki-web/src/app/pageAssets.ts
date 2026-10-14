/**
 * Files in a page, the way the desktop Local wiki handles them
 * (electron `services/localWikiAttachments.ts`): a pasted or dropped file goes
 * to the page's `.assets/` folder and the body links to it relatively, so the
 * page reads the same in the app, in a text editor and on GitHub. Images the
 * browser can show become image nodes; anything else is a link.
 */
import type { UploadedEditorAsset } from '@nimbalyst/collab-bundle/editor';
import { wikiApi } from '../api/client';

/** HEIC and other formats browsers cannot decode are attached as files. */
const INLINE_IMAGE_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/avif', 'image/bmp',
]);

export function pageUploadAsset(pageId: string): (file: File) => Promise<UploadedEditorAsset> {
  return async (file) => {
    const name = file.name || (file.type.startsWith('image/') ? `image.${file.type.slice(6).replace(/\+.*$/, '')}` : 'attachment');
    const { link } = await wikiApi.storeAttachment(pageId, name, file);
    return INLINE_IMAGE_TYPES.has(file.type) ? { kind: 'image', src: link, altText: name } : { kind: 'file', src: link, name };
  };
}

/** Anything with a scheme, an absolute path or a fragment is not a file in the wiki. */
const NOT_A_WIKI_PATH = /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i;

/** Maps an image src written in the page to the server's file route; other srcs are left to the editor. */
export function pageImageResolver(pageId: string): (src: string) => Promise<string | null> {
  return async (src) => {
    if (!src || NOT_A_WIKI_PATH.test(src)) return null;
    const path = src.replace(/^\.\//, '').replace(/[?#].*$/, '');
    return path ? wikiApi.pageFileUrl(pageId, path) : null;
  };
}
