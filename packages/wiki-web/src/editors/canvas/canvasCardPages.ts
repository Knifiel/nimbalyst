/**
 * Which wiki page a Project canvas card shows. A card names its file the way
 * the desktop writes it: relative to the project (workspace) root. In the
 * browser view the file must be a page of this wiki; anything else is shown as
 * a placeholder. Paths relative to the wiki folder are accepted too, since an
 * agent working in the wiki may write them that way.
 */
import type { LocalPage } from '@nimbalyst/local-wiki';

export interface CanvasCardRoots {
  /** Absolute path of the wiki folder. */
  wikiRoot: string;
  /** Absolute path of the project the wiki belongs to, when it has one. */
  projectRoot: string | null;
}

function normalize(value: string): string {
  const parts: string[] = [];
  for (const part of value.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

function relativeTo(root: string, absolute: string): string | null {
  const base = normalize(root);
  const target = normalize(absolute);
  return target === base ? '' : target.startsWith(`${base}/`) ? target.slice(base.length + 1) : null;
}

/** The live page a card's file path names, or null when it is not a page of this wiki. */
export function canvasCardPage(path: string, pages: Iterable<LocalPage>, roots: CanvasCardRoots): LocalPage | null {
  const absolute = path.startsWith('/');
  const candidates = new Set<string>();
  if (absolute) {
    const inWiki = relativeTo(roots.wikiRoot, path);
    if (inWiki) candidates.add(inWiki);
  } else {
    if (roots.projectRoot) {
      const inWiki = relativeTo(roots.wikiRoot, `${roots.projectRoot}/${path}`);
      if (inWiki) candidates.add(inWiki);
    }
    candidates.add(normalize(path));
  }
  for (const page of pages) {
    if (page.trashedAt === null && page.path && candidates.has(normalize(page.path))) return page;
  }
  return null;
}
