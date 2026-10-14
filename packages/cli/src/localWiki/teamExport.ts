/**
 * The local wiki as `pages_import` entries, for moving it to a team project:
 * pages and typed pages in tree order (a parent always before its children),
 * table rows as typed pages, the wiki types they use, and the link rewrite
 * that runs once the server has assigned every page its team link.
 *
 * Editor pages (drawings, spreadsheets, ...) have no team import yet; they are
 * reported as skipped and their children move up to the nearest imported page.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';
import { findLinks, type LocalPage, type LocalWiki } from '@nimbalyst/local-wiki';
import { buildTree, livePages } from './tree.js';

export interface ImportPage {
  localId: string;
  parentLocalId: string | null;
  title: string;
  order?: number;
  kind: 'page' | 'typedPage';
  typeId?: string;
  fields?: Record<string, unknown>;
  body: string;
}

export interface ImportType {
  id: string;
  name: string;
  definition: unknown;
}

export interface SkippedPage {
  localId: string;
  title: string;
  reason: string;
}

/** Where a page sits, for resolving path-only links. */
interface PageLocation {
  path: string | null;
  dir: string;
}

export interface LocalWikiExport {
  pages: ImportPage[];
  types: ImportType[];
  skipped: SkippedPage[];
  /** The page the banner goes on: the root page titled Home, else the first root page. */
  homeLocalId: string | null;
  locations: Map<string, PageLocation>;
  /**
   * Relationship field values by page, as local ids. They are left out of each
   * page's `fields` and sent once every target has its team id.
   */
  relations: Map<string, Record<string, string | string[]>>;
}

/** A stored relationship value as local ids: an id, a list of ids, or `{ itemId }` forms of either. */
function relationIds(value: unknown): string | string[] | undefined {
  const one = (v: unknown) => (typeof v === 'string' && v ? v : v && typeof v === 'object' && typeof (v as { itemId?: unknown }).itemId === 'string' ? (v as { itemId: string }).itemId : undefined);
  if (Array.isArray(value)) return value.map(one).filter((id): id is string => Boolean(id));
  return one(value);
}

function splitRelations(
  fields: Record<string, unknown>,
  relationFields: Set<string> | undefined,
): { fields: Record<string, unknown>; relations: Record<string, string | string[]> } {
  const plain: Record<string, unknown> = {};
  const relations: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!relationFields?.has(key)) plain[key] = value;
    else {
      const ids = relationIds(value);
      if (ids !== undefined && (!Array.isArray(ids) || ids.length)) relations[key] = ids;
    }
  }
  return { fields: plain, relations };
}

export const MIGRATION_BANNER_PREFIX = 'This wiki moved to the team project:';

export const migrationBanner = (link: string) => `${MIGRATION_BANNER_PREFIX} ${link}`;

/** The body without the banner a previous move put on top, so a re-run imports what the user wrote. */
export function stripMigrationBanner(body: string): string {
  const lines = body.split('\n');
  if (!lines[0]?.startsWith(MIGRATION_BANNER_PREFIX)) return body;
  let at = 1;
  while (at < lines.length && lines[at].trim() === '') at++;
  return lines.slice(at).join('\n');
}

function readTypeDefinition(file: string): unknown {
  try {
    return yaml.load(fs.readFileSync(file, 'utf8'), { schema: yaml.CORE_SCHEMA }) ?? null;
  } catch {
    return null;
  }
}

export async function collectLocalWiki(wiki: LocalWiki): Promise<LocalWikiExport> {
  const snapshot = await wiki.snapshot();
  const live = livePages(snapshot);
  const byId = new Map(live.map((page) => [page.id, page]));
  const skipped: SkippedPage[] = [];
  const included = (page: LocalPage) => page.documentType === 'markdown';
  for (const page of live) {
    if (!included(page)) skipped.push({ localId: page.id, title: page.title, reason: `${page.documentType} page (no team import yet)` });
  }

  /** The nearest ancestor that is imported; a skipped editor page passes its children up. */
  const importedParent = (parentId: string | null): string | null => {
    const seen = new Set<string>();
    let at = parentId;
    while (at && !seen.has(at)) {
      seen.add(at);
      const parent = byId.get(at);
      if (!parent) return null;
      if (included(parent)) return parent.id;
      at = parent.parentId;
    }
    return null;
  };

  const pages: ImportPage[] = [];
  const locations = new Map<string, PageLocation>();
  const usedTypes = new Set<string>();
  const relationFieldsByType = new Map(
    wiki.typeDefs().map((def) => [def.typeId, new Set(def.fields.filter((f) => f.type === 'relationship').map((f) => f.name))]),
  );
  const relations = new Map<string, Record<string, string | string[]>>();
  const withFields = (localId: string, typeId: string | null, all: Record<string, unknown>) => {
    const split = splitRelations(all, typeId ? relationFieldsByType.get(typeId) : undefined);
    if (Object.keys(split.relations).length) relations.set(localId, split.relations);
    return Object.keys(split.fields).length ? { fields: split.fields } : {};
  };
  for (const node of buildTree(snapshot)) {
    if (node.kind === 'type') {
      const tracker = await wiki.trackerSnapshot(node.id);
      const parentLocalId = importedParent(node.parentNodeId ? node.parentNodeId.replace(/^(document|item):/, '') : null);
      usedTypes.add(node.id);
      tracker.items.forEach((item, index) => {
        pages.push({
          localId: item.id,
          parentLocalId,
          title: item.title,
          order: item.order ?? (index + 1) * 1000,
          kind: 'typedPage',
          typeId: node.id,
          ...withFields(item.id, node.id, item.fields),
          body: '',
        });
      });
      continue;
    }
    const page = byId.get(node.id);
    if (!page || !included(page)) continue;
    const { markdown } = await wiki.readBody(page.id);
    if (page.type) usedTypes.add(page.type);
    locations.set(page.id, { path: page.path, dir: page.dir });
    pages.push({
      localId: page.id,
      parentLocalId: importedParent(page.parentId),
      title: page.title,
      ...(page.order !== null ? { order: page.order } : {}),
      kind: page.type ? 'typedPage' : 'page',
      ...(page.type ? { typeId: page.type } : {}),
      ...withFields(page.id, page.type, page.fields),
      body: stripMigrationBanner(markdown),
    });
  }

  const types: ImportType[] = [];
  for (const def of wiki.typeDefs()) {
    if (!usedTypes.has(def.typeId) && !def.wikiType) continue;
    types.push({ id: def.typeId, name: def.displayName, definition: readTypeDefinition(def.sourcePath) });
  }

  const roots = pages.filter((page) => page.parentLocalId === null && page.kind === 'page');
  const home = roots.find((page) => page.title.trim().toLowerCase() === 'home') ?? roots[0] ?? null;
  return { pages, types, skipped, homeLocalId: home?.localId ?? null, locations, relations };
}

/** Wiki-relative folder a page's links are written relative to (see FORMAT.md, Links). */
function linkBase(location: PageLocation): string {
  return location.path ? path.posix.dirname(location.path).replace(/^\.$/, '') : location.dir;
}

function resolveRelative(base: string, linkPath: string): string | null {
  const joined = path.posix.normalize(path.posix.join(base === '' ? '.' : base, linkPath));
  if (joined === '..' || joined.startsWith('../') || path.posix.isAbsolute(joined)) return null;
  return (joined === '.' ? '' : joined).replace(/\/$/, '').toLowerCase();
}

/** Lowercased wiki-relative page file and folder paths to page ids, for links written without an id. */
export function pathIndex(locations: Map<string, PageLocation>): Map<string, string> {
  const byPath = new Map<string, string>();
  for (const [id, location] of locations) {
    byPath.set(location.dir.toLowerCase(), id);
    if (location.path) byPath.set(location.path.toLowerCase(), id);
  }
  return byPath;
}

/**
 * Rewrites every link to another wiki page into its team link: by the link's
 * `id=` title first, else by its relative path. Links to pages the move did
 * not import (an editor page, a page that failed) are left as written.
 */
export function rewriteWikiLinks(
  body: string,
  from: PageLocation,
  byPath: Map<string, string>,
  linkFor: (localId: string) => string | undefined,
): { body: string; rewritten: number } {
  const links = findLinks(body).filter((link) => link.isPageLink);
  let out = '';
  let cursor = 0;
  let rewritten = 0;
  for (const link of links) {
    let href = link.id ? linkFor(link.id) : undefined;
    if (!href && link.path) {
      const resolved = resolveRelative(linkBase(from), link.path);
      const targetId = resolved === null ? undefined : byPath.get(resolved);
      if (targetId) href = linkFor(targetId);
    }
    if (!href) continue;
    out += body.slice(cursor, link.start) + `[${link.text}](${href}${link.fragment})`;
    cursor = link.end;
    rewritten++;
  }
  return rewritten ? { body: out + body.slice(cursor), rewritten } : { body, rewritten: 0 };
}
