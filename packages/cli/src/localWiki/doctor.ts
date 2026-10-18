/**
 * What is wrong with a local wiki, read-only: every scan issue, pages nothing
 * links to, pages whose covered code changed on the default branch after the
 * page did, near-duplicate titles, and `current` pages whose `paths` match no
 * file any more. The agent fixes them with the ordinary page tools.
 */
import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import type { LocalPage, LocalWiki, WikiIssueCode } from '@nimbalyst/local-wiki';
import { checkoutFiles, defaultBranch, filesAt, newestCommits, pageClocks, pagePaths, pathsCover, repoRoot, resolveCommit, staleness, type PageClock } from './coverage.js';

export const DOCTOR_DEFAULT_LIMIT = 20;

interface PageRef {
  id: string;
  title: string;
  path: string | null;
}

export interface StalePage extends PageRef {
  /** Covered files at the base, at most a few; `fileCount` has them all. */
  files: string[];
  fileCount: number;
  clock: PageClock['clock'];
  lastChange: string;
  /** The newest commit on the base that touched a covered file. */
  fileChange: string;
}

export interface DoctorReport {
  summary: { issues: number; orphans: number; stale: number; duplicateTitles: number; deadPaths: number };
  issues: { total: number; byCode: Partial<Record<WikiIssueCode, number>>; items: Array<{ code: WikiIssueCode; path: string; message: string }> };
  orphans: { total: number; pages: PageRef[] };
  stale: { base: string | null; total: number; pages: StalePage[]; note?: string };
  duplicateTitles: { total: number; groups: PageRef[][] };
  deadPaths: { total: number; pages: Array<PageRef & { paths: string[] }>; note?: string };
}

export interface DoctorOptions {
  /** Where the agent works: the repository whose files the pages' `paths` name. */
  startDir: string;
  /** Branch or ref the stale check compares with. Default: the default branch. */
  base?: string;
  /** Entries per group. Default 20. */
  limit?: number;
}

/** Files listed per stale page; the count carries the rest. */
const FILES_SHOWN = 5;

const ref = (page: LocalPage): PageRef => ({ id: page.id, title: page.title, path: page.path });

function singular(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us') && !word.endsWith('is')) return word.slice(0, -1);
  return word;
}

/** A title folded for comparison: case, punctuation and plural endings removed. */
export function titleKey(title: string): string {
  return title
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map(singular)
    .join(' ');
}

function isHome(page: LocalPage): boolean {
  return page.parentId === null && page.type === null && page.title.trim().toLowerCase() === 'home';
}

export async function wikiDoctor(opened: { dir: string; wiki: LocalWiki }, options: DoctorOptions): Promise<DoctorReport> {
  const limit = Math.max(1, Math.floor(options.limit ?? DOCTOR_DEFAULT_LIMIT));
  const snapshot = await opened.wiki.snapshot();
  const live = snapshot.pages.filter((page) => page.trashedAt === null && !page.malformed);

  const byCode: Partial<Record<WikiIssueCode, number>> = {};
  for (const issue of snapshot.issues) byCode[issue.code] = (byCode[issue.code] ?? 0) + 1;
  const issues = {
    total: snapshot.issues.length,
    byCode,
    items: snapshot.issues.slice(0, limit).map(({ code, path: where, message }) => ({ code, path: where, message })),
  };

  // Typed pages are rows of their type's table, reached from there, so only plain pages can be orphans.
  const outbound = await opened.wiki.outboundLinks();
  const linked = new Set<string>();
  for (const [from, targets] of outbound) for (const to of targets) if (to !== from) linked.add(to);
  const orphanPages = live.filter((page) => page.type === null && !isHome(page) && !linked.has(page.id)).sort((a, b) => a.title.localeCompare(b.title));

  const groups = new Map<string, LocalPage[]>();
  for (const page of live) {
    const key = titleKey(page.title);
    if (key) groups.set(key, [...(groups.get(key) ?? []), page]);
  }
  const duplicates = [...groups.values()].filter((group) => group.length > 1).map((group) => group.sort((a, b) => a.title.localeCompare(b.title)).map(ref));

  const root = repoRoot(options.startDir);
  const covering = live.filter((page) => pagePaths(page).length > 0);
  const stale: DoctorReport['stale'] = { base: null, total: 0, pages: [] };
  const dead: DoctorReport['deadPaths'] = { total: 0, pages: [] };
  if (!root) {
    stale.note = 'Not in a git repository: there is no branch to compare pages with.';
    dead.note = 'Not in a git repository: page paths were not checked against files.';
  } else {
    const base = options.base ?? defaultBranch(root);
    // Only a resolved hash reaches git: a base such as `--output=...` is never an argument.
    const commit = base ? resolveCommit(root, base) : undefined;
    if (!base || !commit) {
      stale.note = base ? `${base} is not a commit in this repository.` : 'No default branch (origin/HEAD, main or master) to compare pages with.';
    } else {
      stale.base = base;
      const wikiRel = path.relative(realpathSync(root), realpathSync(opened.dir)).split(path.sep).join('/');
      // The wiki's own files are not code a page covers.
      const code = filesAt(root, commit).filter((file) => !(wikiRel && (file === wikiRel || file.startsWith(`${wikiRel}/`))));
      const matched = covering
        .map((page) => ({ page, files: code.filter((file) => pathsCover(pagePaths(page), file)) }))
        .filter(({ files }) => files.length > 0);
      // One walk of the base's history for every covered file, and one of the wiki folder for every page.
      const newest = newestCommits(root, [...new Set(matched.flatMap(({ files }) => files))], { ref: commit });
      const clocks = pageClocks(opened.dir, matched.map(({ page }) => page));
      const found: StalePage[] = [];
      let unknown = 0;
      for (const { page, files } of matched) {
        const changed = Math.max(...files.map((file) => newest.get(file)?.at ?? 0));
        const clock = clocks.get(page.id)!;
        const verdict = staleness(clock, changed || undefined);
        if (verdict === null) unknown++;
        if (!verdict) continue;
        found.push({
          ...ref(page),
          files: files.slice(0, FILES_SHOWN),
          fileCount: files.length,
          clock: clock.clock,
          lastChange: new Date(clock.at).toISOString(),
          fileChange: new Date(changed).toISOString(),
        });
      }
      found.sort((a, b) => a.title.localeCompare(b.title));
      stale.total = found.length;
      stale.pages = found.slice(0, limit);
      if (unknown > 0) stale.note = `${unknown} covering page${unknown === 1 ? '' : 's'} could not be dated: this is a shallow clone and their last commit is where its history stops.`;
    }
    const files = checkoutFiles(root);
    const deadPages = covering
      .filter((page) => page.fields.status === 'current')
      .filter((page) => !files.some((file) => pathsCover(pagePaths(page), file)))
      .sort((a, b) => a.title.localeCompare(b.title));
    dead.total = deadPages.length;
    dead.pages = deadPages.slice(0, limit).map((page) => ({ ...ref(page), paths: pagePaths(page) }));
  }

  return {
    summary: { issues: issues.total, orphans: orphanPages.length, stale: stale.total, duplicateTitles: duplicates.length, deadPaths: dead.total },
    issues,
    orphans: { total: orphanPages.length, pages: orphanPages.slice(0, limit).map(ref) },
    stale,
    duplicateTitles: { total: duplicates.length, groups: duplicates.slice(0, limit) },
    deadPaths: dead,
  };
}
