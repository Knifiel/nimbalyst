/**
 * Which local wiki pages cover which files. A page names the code it explains
 * in its `paths` field (repository-relative, .gitignore-style globs; see
 * packages/local-wiki/FORMAT.md), and a page is stale when a file it covers has
 * a commit newer than the page's own last change.
 *
 * The page's last change is its file's last commit when git tracks it. A wiki
 * git does not track (the private one under the gitignored `nimbalyst-local/`)
 * falls back to the file mtime, which a checkout or copy resets, so every
 * result says which clock it used.
 *
 * Shared by the `pagesForFiles` tool, the SessionStart context hook and the
 * Stop hook, so it stays free of anything but git and the wiki snapshot.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import * as path from 'node:path';
import type { LocalPage, LocalWiki } from '@nimbalyst/local-wiki';
import { usageError } from '../cli/exitCodes.js';

export interface CoveredPage {
  id: string;
  title: string;
  /** Repository-relative files the page's `paths` matched. */
  files: string[];
  /**
   * A matched file has a commit newer than `lastChange`. Null when that cannot
   * be known: the page's last commit is where a shallow clone's history stops,
   * so its real change may be older.
   */
  stale: boolean | null;
  /**
   * Where `lastChange` came from: the page file's last commit (`git`), that
   * commit when it is a shallow clone's boundary (`shallow`), or its mtime when
   * git does not track it (`mtime`).
   */
  clock: PageClock['clock'];
  lastChange: string;
}

export interface PagesForFilesResult {
  /** `working tree` (uncommitted and untracked), `since <ref>`, or `given`. */
  source: string;
  files: string[];
  pages: CoveredPage[];
}

export interface PagesForFilesOptions {
  /** Where the agent works: the repository whose files are checked (a worktree has its own changes). */
  startDir: string;
  /** Files to check, absolute or repository-relative. Default: the working tree's changes. */
  files?: string[];
  /** A git ref: check the files changed in `<since>...HEAD` instead of the working tree. */
  since?: string;
  /** Wall-clock ms after which no more git runs: the call throws DeadlineExceeded. For the hooks. */
  deadline?: number;
}

export interface PageClock {
  clock: 'git' | 'shallow' | 'mtime';
  /** ms */
  at: number;
}

/** A bounded caller (the session hooks) ran out of time; it should give up quietly. */
export class DeadlineExceeded extends Error {
  constructor() {
    super('wiki coverage: deadline passed');
    this.name = 'DeadlineExceeded';
  }
}

const GIT_TIMEOUT_MS = 5000;

/**
 * Runs git; undefined when it fails. Every argument that came from a person or
 * a page is a resolved commit hash or a path after `--`, and
 * `--literal-pathspecs` keeps a path from being read as pathspec magic.
 */
function git(cwd: string, args: string[], deadline?: number): string | undefined {
  const left = deadline === undefined ? GIT_TIMEOUT_MS : deadline - Date.now();
  if (left <= 0) throw new DeadlineExceeded();
  try {
    return execFileSync('git', ['--literal-pathspecs', ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: Math.min(GIT_TIMEOUT_MS, left),
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    if (deadline !== undefined && Date.now() >= deadline) throw new DeadlineExceeded();
    return undefined;
  }
}

/** NUL-separated (`-z`) output: names exactly as stored, never quoted or trimmed. */
const entries = (out: string | undefined) => (out ?? '').split('\0').filter(Boolean);
const uniqueSorted = (list: string[]) => [...new Set(list)].sort();

function escapeRegex(text: string): string {
  return text.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/**
 * A `[...]` class starting at `open`: `[abc]`, `[a-z]`, `[!abc]` or `[^abc]`,
 * with a `]` first in the set taken literally. Never matches `/`. Null when
 * the bracket is not closed, so it is read literally.
 */
function charClass(pattern: string, open: number): { regex: string; end: number } | null {
  let start = open + 1;
  const negate = pattern[start] === '!' || pattern[start] === '^';
  if (negate) start++;
  const close = pattern.indexOf(']', start + 1);
  if (close === -1) return null;
  const members = pattern.slice(start, close).replace(/[\\^[\]]/g, '\\$&');
  return { regex: negate ? `[^/${members}]` : `(?!/)[${members}]`, end: close };
}

const globCache = new Map<string, RegExp | null>();

function globRegex(glob: string): RegExp | null {
  const cached = globCache.get(glob);
  if (cached !== undefined) return cached;
  let pattern = glob.trim().replace(/\\/g, '/');
  let regex: RegExp | null = null;
  if (pattern && !pattern.startsWith('#')) {
    // As in .gitignore: a slash anywhere but the end anchors the glob at the root; without one it matches at any depth.
    const anchored = pattern.replace(/\/+$/, '').includes('/');
    pattern = pattern.replace(/^\/+/, '').replace(/\/+$/, '');
    let body = '';
    for (let i = 0; i < pattern.length; i++) {
      const ch = pattern[i];
      if (pattern.startsWith('**/', i)) {
        body += '(?:.*/)?';
        i += 2;
      } else if (pattern.startsWith('/**', i) && i + 3 === pattern.length) {
        body += '(?:/.*)?';
        i += 2;
      } else if (pattern.startsWith('**', i)) {
        body += '.*';
        i += 1;
      } else if (ch === '*') body += '[^/]*';
      else if (ch === '?') body += '[^/]';
      else if (ch === '[') {
        const cls = charClass(pattern, i);
        if (cls) {
          body += cls.regex;
          i = cls.end;
        } else body += '\\[';
      } else body += escapeRegex(ch);
    }
    // A glob that names a folder covers everything in it.
    if (body) regex = new RegExp(`^${anchored ? '' : '(?:.*/)?'}${body}(?:/.*)?$`);
  }
  globCache.set(glob, regex);
  return regex;
}

/** Whether a repository-relative `file` is covered by one `paths` glob. */
export function matchesGlob(glob: string, file: string): boolean {
  return globRegex(glob)?.test(file.replace(/\\/g, '/').replace(/^\.\//, '')) ?? false;
}

/**
 * Whether a page's `paths` cover `file`. As in .gitignore, a glob starting
 * with `!` takes back what earlier globs matched, and the last glob that
 * matches decides; unlike .gitignore, a file can be put back under a folder an
 * earlier `!` took away.
 */
export function pathsCover(globs: string[], file: string): boolean {
  let covered = false;
  for (const raw of globs) {
    const glob = raw.trim();
    if (glob.startsWith('!')) {
      if (covered && matchesGlob(glob.slice(1), file)) covered = false;
    } else if (!covered && matchesGlob(glob, file)) covered = true;
  }
  return covered;
}

/** A page's `paths` field as a list: YAML may hold one string or a list. */
export function pagePaths(page: Pick<LocalPage, 'fields'>): string[] {
  const value = page.fields.paths;
  const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return list.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

/** The repository root `startDir` is in; undefined outside git. */
export function repoRoot(startDir: string, deadline?: number): string | undefined {
  return git(startDir, ['rev-parse', '--show-toplevel'], deadline)?.trim() || undefined;
}

/** The commit `ref` names, as a full hash; undefined for anything else, including text that starts with `-`. */
export function resolveCommit(root: string, ref: string, deadline?: number): string | undefined {
  if (!ref.trim() || ref.startsWith('-')) return undefined;
  const hash = git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], deadline)?.trim();
  return hash && /^[0-9a-f]{40,64}$/.test(hash) ? hash : undefined;
}

const DIFF = ['diff', '--name-only', '-z', '--no-renames'];

/**
 * Uncommitted (staged or not) and untracked files, or with `since` (a resolved
 * commit) the files changed in `<since>...HEAD`. A rename lists both paths.
 */
export function changedFiles(root: string, since?: string, deadline?: number): string[] {
  if (since) return uniqueSorted(entries(git(root, [...DIFF, `${since}...HEAD`, '--'], deadline)));
  const changed = resolveCommit(root, 'HEAD', deadline)
    ? entries(git(root, [...DIFF, 'HEAD', '--'], deadline))
    : // No commit yet: what is staged, and what changed since it was staged.
      [...entries(git(root, [...DIFF, '--cached', '--'], deadline)), ...entries(git(root, [...DIFF, '--'], deadline))];
  const untracked = entries(git(root, ['ls-files', '-z', '--others', '--exclude-standard'], deadline));
  return uniqueSorted([...changed, ...untracked]);
}

interface Commit {
  hash: string;
  /** ms */
  at: number;
}

/** The newest commit reachable from `ref` (default HEAD) that touched `file` (repository-relative). */
function lastCommitOf(root: string, file: string, ref?: string, deadline?: number): Commit | undefined {
  const out = git(root, ['log', '-1', '--format=%H %ct', ...(ref ? [ref] : []), '--', file], deadline)?.trim();
  if (!out) return undefined;
  const [hash, seconds] = out.split(' ');
  return { hash, at: Number(seconds) * 1000 };
}

/** Pathspecs per history walk, well under any command-line limit. */
const PATHS_PER_WALK = 1000;

/**
 * The newest commit reachable from `ref` (default HEAD) for every file under
 * `pathspecs`, in one walk of the history per 1,000 pathspecs. Names are
 * repository-relative.
 */
export function newestCommits(root: string, pathspecs: string[], options: { ref?: string; deadline?: number } = {}): Map<string, Commit> {
  const newest = new Map<string, Commit>();
  for (let i = 0; i < pathspecs.length; i += PATHS_PER_WALK) {
    const args = ['log', '--no-renames', '--format=%x01%H %ct', '--name-only', '-z', ...(options.ref ? [options.ref] : []), '--', ...pathspecs.slice(i, i + PATHS_PER_WALK)];
    let current: Commit | undefined;
    for (const token of (git(root, args, options.deadline) ?? '').split('\0')) {
      if (token.startsWith('\x01')) {
        const [hash, seconds] = token.slice(1).split(' ');
        current = { hash, at: Number(seconds) * 1000 };
        continue;
      }
      // The first name after a commit header follows a newline.
      const name = token.startsWith('\n') ? token.slice(1) : token;
      if (name && current && !newest.has(name)) newest.set(name, current);
    }
  }
  return newest;
}

/** The default branch: `origin/HEAD`, else a local `main` or `master`; undefined when none exists. */
export function defaultBranch(root: string): string | undefined {
  const remote = git(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])?.trim();
  if (remote) return remote;
  return ['main', 'master'].find((name) => resolveCommit(root, `refs/heads/${name}`) !== undefined);
}

/** Files in the tree at `commit` (a resolved hash). */
export function filesAt(root: string, commit: string): string[] {
  return entries(git(root, ['ls-tree', '-r', '-z', '--name-only', commit]));
}

/** Files in the checkout: tracked and untracked, not ignored, and not deleted from disk. */
export function checkoutFiles(root: string): string[] {
  const deleted = new Set(entries(git(root, ['ls-files', '-z', '--deleted'])));
  return uniqueSorted(entries(git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).filter((file) => !deleted.has(file)));
}

/** Commits where a shallow clone's history stops; empty in a full clone. */
function shallowBoundaries(root: string, deadline?: number): Set<string> {
  if (git(root, ['rev-parse', '--is-shallow-repository'], deadline)?.trim() !== 'true') return new Set();
  const file = git(root, ['rev-parse', '--git-path', 'shallow'], deadline)?.trim();
  if (!file) return new Set();
  try {
    return new Set(readFileSync(path.resolve(root, file), 'utf8').split('\n').map((line) => line.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

/**
 * When each page last changed: its file's last commit when git tracks it (one
 * history walk over the wiki folder for all pages), else the file mtime.
 */
export function pageClocks(wikiDir: string, pages: LocalPage[], deadline?: number): Map<string, PageClock> {
  const clocks = new Map<string, PageClock>();
  const top = repoRoot(wikiDir, deadline);
  let history = new Map<string, Commit>();
  let boundaries = new Set<string>();
  let wikiRel = '';
  if (top) {
    wikiRel = path.relative(realish(top), realish(wikiDir)).split(path.sep).join('/');
    const folder = wikiRel || '.';
    // A wiki git ignores (the private one under nimbalyst-local/) has no history to walk.
    if (entries(git(top, ['ls-files', '-z', '--', folder], deadline)).length > 0) {
      history = newestCommits(top, [folder], { deadline });
      boundaries = shallowBoundaries(top, deadline);
    }
  }
  for (const page of pages) {
    const commit = page.path ? history.get(wikiRel ? `${wikiRel}/${page.path}` : page.path) : undefined;
    if (commit) {
      clocks.set(page.id, { clock: boundaries.has(commit.hash) ? 'shallow' : 'git', at: commit.at });
      continue;
    }
    const mtime = page.path ? statSync(path.join(wikiDir, page.path), { throwIfNoEntry: false })?.mtimeMs : undefined;
    clocks.set(page.id, { clock: 'mtime', at: mtime ?? page.updatedAt });
  }
  return clocks;
}

/** Stale when a covered file has a newer commit; unknown when the page's commit is a shallow boundary. */
export function staleness(page: PageClock, newestFileChange: number | undefined): boolean | null {
  if (newestFileChange !== undefined && newestFileChange > page.at) return true;
  return page.clock === 'shallow' ? null : false;
}

/** `file` with symlinks resolved as far as it exists, so `/var/x` and git's `/private/var/x` agree. */
function realish(file: string): string {
  for (let at = file, rest = ''; at !== path.dirname(at); rest = path.join(path.basename(at), rest), at = path.dirname(at)) {
    try {
      return path.join(realpathSync(at), rest);
    } catch {
      // not there (a deleted file): resolve its folder instead
    }
  }
  return file;
}

/**
 * `file` (absolute, or relative to the repository root) as a canonical
 * repository-relative path; undefined when it resolves outside, through `..`
 * or a symlink.
 */
function inRepository(root: string, file: string): string | undefined {
  const rel = path.relative(realish(root), realish(path.resolve(root, file)));
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return undefined;
  return rel.split(path.sep).join('/');
}

/** The wiki's live pages with their `paths`, each matched against `files`. */
export function matchPages(pages: LocalPage[], files: string[]): Array<{ page: LocalPage; files: string[] }> {
  const out: Array<{ page: LocalPage; files: string[] }> = [];
  for (const page of pages) {
    if (page.trashedAt !== null) continue;
    const globs = pagePaths(page);
    if (globs.length === 0) continue;
    const matched = files.filter((file) => pathsCover(globs, file));
    if (matched.length > 0) out.push({ page, files: matched });
  }
  return out.sort((a, b) => a.page.title.localeCompare(b.page.title));
}

export async function pagesForFiles(opened: { dir: string; wiki: LocalWiki }, options: PagesForFilesOptions): Promise<PagesForFilesResult> {
  const { deadline } = options;
  const gitRoot = repoRoot(options.startDir, deadline);
  const root = gitRoot ?? path.resolve(options.startDir);
  let source: string;
  let files: string[];
  if (options.files && options.files.length > 0) {
    source = 'given';
    // A file outside the repository is covered by nothing, and an unanchored glob (`*.ts`) would match it.
    files = uniqueSorted(options.files.map((file) => inRepository(root, file)).filter((file): file is string => file !== undefined));
  } else if (options.since) {
    source = `since ${options.since}`;
    const commit = gitRoot ? resolveCommit(gitRoot, options.since, deadline) : undefined;
    if (!commit) throw usageError(`\`since\` is not a commit in this repository: ${options.since}`);
    files = changedFiles(root, commit, deadline);
  } else {
    source = 'working tree';
    files = gitRoot ? changedFiles(root, undefined, deadline) : [];
  }
  if (files.length === 0) return { source, files, pages: [] };
  const { pages } = await opened.wiki.snapshot();
  const matches = matchPages(pages, files);
  const clocks = pageClocks(opened.dir, matches.map(({ page }) => page), deadline);
  // One lookup per file, shared by every page that covers it.
  const fileChanges = new Map<string, number | undefined>();
  const changedAt = (file: string) => {
    if (!fileChanges.has(file)) fileChanges.set(file, gitRoot ? lastCommitOf(gitRoot, file, undefined, deadline)?.at : undefined);
    return fileChanges.get(file);
  };
  const covered: CoveredPage[] = matches.map(({ page, files: matched }) => {
    const clock = clocks.get(page.id)!;
    const newest = Math.max(...matched.map((file) => changedAt(file) ?? 0));
    return { id: page.id, title: page.title, files: matched, stale: staleness(clock, newest || undefined), clock: clock.clock, lastChange: new Date(clock.at).toISOString() };
  });
  return { source, files, pages: covered };
}
