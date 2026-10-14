/**
 * Links the `@` picker writes in a local wiki page: relative to the linking
 * page's file, carrying the target's id in the title, as FORMAT.md "Links"
 * defines and the library itself writes when it repairs links. The inverse of
 * `links.ts`.
 */
import type { LocalPage } from '@nimbalyst/local-wiki';
import type { PageLinkOption } from '@nimbalyst/collab-bundle/editor';

function dirname(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

/** Folder a page's links are written relative to (the library's `linkBaseDir`). */
function linkBaseDir(page: Pick<LocalPage, 'path' | 'dir'>): string {
  return page.path ? dirname(page.path) : page.dir;
}

/** `to` relative to the folder `fromDir`, both wiki-relative. */
export function relativePath(fromDir: string, to: string): string {
  const from = fromDir ? fromDir.split('/') : [];
  const target = to.split('/');
  let common = 0;
  while (common < from.length && common < target.length - 1 && from[common] === target[common]) common++;
  return [...from.slice(common).map(() => '..'), ...target.slice(common)].join('/');
}

/** Same escaping as the library's `encodeLinkPath`: spaces and the characters that end a link destination. */
export function encodeLinkPath(relPath: string): string {
  return relPath
    .split('/')
    .map((segment) => segment.replace(/[%\s()<>#?"]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')))
    .join('/');
}

/** How `from` links to `target`: its file, or its folder with a trailing `/` when it has no file. */
export function pageLinkOption(from: Pick<LocalPage, 'path' | 'dir'> | null, target: LocalPage): PageLinkOption {
  const base = from ? linkBaseDir(from) : '';
  const href = target.path ? encodeLinkPath(relativePath(base, target.path)) : `${encodeLinkPath(relativePath(base, target.dir))}/`;
  const folder = target.path ? dirname(target.path) : dirname(target.dir);
  return {
    id: target.id,
    title: target.title,
    href,
    linkTitle: `id=${target.id}`,
    ...(folder ? { folderPath: folder } : {}),
    icon: target.type ? 'sell' : target.documentType === 'markdown' ? 'description' : 'draw',
  };
}

/** Every live page the open page can link to, itself excluded. */
export function pageLinkOptions(pages: Iterable<LocalPage>, fromId: string): PageLinkOption[] {
  const all = [...pages].filter((page) => page.trashedAt === null && !page.malformed);
  const from = all.find((page) => page.id === fromId) ?? null;
  return all.filter((page) => page.id !== fromId).map((page) => pageLinkOption(from, page));
}
