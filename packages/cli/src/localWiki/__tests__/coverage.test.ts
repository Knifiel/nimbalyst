// @vitest-environment node
/**
 * Which local wiki pages cover which files (`paths` globs on a page), and
 * whether a covered file changed in a commit newer than the page. Runs in a
 * temp git repository with fixed commit dates.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { initLocalWiki, openLocalWiki, type OpenedWiki } from '../open.js';
import { matchesGlob, pagesForFiles, pathsCover } from '../coverage.js';

const dirs: string[] = [];
const wikis: OpenedWiki[] = [];
afterEach(() => {
  for (const opened of wikis.splice(0)) opened.wiki.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('matchesGlob', () => {
  it('reads globs the way .gitignore does', () => {
    expect(matchesGlob('src/sync/**', 'src/sync/a.ts')).toBe(true);
    expect(matchesGlob('src/sync/**', 'src/sync/deep/b.ts')).toBe(true);
    expect(matchesGlob('src/sync/**', 'src/syncing/a.ts')).toBe(false);
    // A folder covers what is in it, with or without a trailing slash.
    expect(matchesGlob('packages/cli', 'packages/cli/src/x.ts')).toBe(true);
    expect(matchesGlob('packages/cli/', 'packages/cli/src/x.ts')).toBe(true);
    expect(matchesGlob('packages/cli/src/mcp/*.ts', 'packages/cli/src/mcp/a.ts')).toBe(true);
    expect(matchesGlob('packages/cli/src/mcp/*.ts', 'packages/cli/src/mcp/sub/a.ts')).toBe(false);
    // No slash: any depth. A leading slash anchors at the root.
    expect(matchesGlob('*.proto', 'api/v1/user.proto')).toBe(true);
    expect(matchesGlob('/docs', 'docs/a.md')).toBe(true);
    expect(matchesGlob('/docs', 'site/docs/a.md')).toBe(false);
    expect(matchesGlob('**/schema.sql', 'db/x/schema.sql')).toBe(true);
    expect(matchesGlob('src/?.ts', 'src/a.ts')).toBe(true);
    expect(matchesGlob('', 'a.ts')).toBe(false);
  });

  it('reads character classes', () => {
    expect(matchesGlob('src/[ab].ts', 'src/a.ts')).toBe(true);
    expect(matchesGlob('src/[ab].ts', 'src/c.ts')).toBe(false);
    expect(matchesGlob('src/[!ab].ts', 'src/c.ts')).toBe(true);
    expect(matchesGlob('src/[!ab].ts', 'src/a.ts')).toBe(false);
    expect(matchesGlob('src/[a-c]*.ts', 'src/beta.ts')).toBe(true);
    expect(matchesGlob('src/[a-c]*.ts', 'src/delta.ts')).toBe(false);
    // A class never matches the folder separator, and an unclosed bracket is literal.
    expect(matchesGlob('src[/]a.ts', 'src/a.ts')).toBe(false);
    expect(matchesGlob('src/[a.ts', 'src/[a.ts')).toBe(true);
  });
});

describe('pathsCover', () => {
  it('applies `!` exclusions in order, the last matching glob deciding', () => {
    const globs = ['src/**', '!src/generated/**'];
    expect(pathsCover(globs, 'src/a.ts')).toBe(true);
    expect(pathsCover(globs, 'src/generated/x.ts')).toBe(false);
    expect(pathsCover([...globs, 'src/generated/keep.ts'], 'src/generated/keep.ts')).toBe(true);
    expect(pathsCover(['!src/x.ts'], 'src/x.ts')).toBe(false);
    expect(pathsCover(['!src/x.ts'], 'src/y.ts')).toBe(false);
  });
});

function git(cwd: string, args: string[], date?: string): string {
  const env = date ? { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : process.env;
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function write(root: string, rel: string, text: string): void {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text);
}

/**
 * A repository with a wiki in `wikiLocation`, a Sync page covering src/sync and
 * a CLI page covering packages/cli, all committed on 2026-01-01.
 */
async function repo(wikiLocation: string): Promise<{ root: string; opened: OpenedWiki }> {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'nim-coverage-')));
  dirs.push(root);
  git(root, ['init', '-q']);
  // Sandboxed: every git command below runs in the temp repository, never this checkout.
  expect(realpathSync(git(root, ['rev-parse', '--show-toplevel']))).toBe(root);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test']);
  const wikiDir = path.join(root, wikiLocation);
  (await initLocalWiki(root, wikiDir)).wiki.close();
  write(wikiDir, 'Sync protocol.md', '---\nid: page-sync\npaths: [src/sync/**]\nsummary: How sync works.\n---\n\nBody.\n');
  write(wikiDir, 'CLI commands.md', '---\nid: page-cli\npaths: packages/cli\n---\n\nBody.\n');
  write(wikiDir, 'Glossary.md', '---\nid: page-glossary\n---\n\nNo paths.\n');
  write(root, 'src/sync/a.ts', 'a\n');
  write(root, 'src/sync/b.ts', 'b\n');
  write(root, 'README.md', 'readme\n');
  const opened = await openLocalWiki(root, wikiDir);
  wikis.push(opened);
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'one'], '2026-01-01T00:00:00Z');
  return { root, opened };
}

describe('pagesForFiles', () => {
  it('finds the pages covering the working tree changes, and marks a page stale only after a newer commit', async () => {
    const { root, opened } = await repo('docs/wiki');
    write(root, 'src/sync/a.ts', 'a2\n');
    git(root, ['commit', '-q', '-am', 'two'], '2026-02-01T00:00:00Z');
    write(root, 'src/sync/b.ts', 'b2\n');
    write(root, 'packages/cli/new.ts', 'new\n');
    write(root, 'README.md', 'readme 2\n');

    const working = await pagesForFiles(opened, { startDir: root });
    expect(working.source).toBe('working tree');
    expect(working.pages).toEqual([
      expect.objectContaining({ id: 'page-cli', title: 'CLI commands', files: ['packages/cli/new.ts'], stale: false, clock: 'git' }),
      expect.objectContaining({ id: 'page-sync', title: 'Sync protocol', files: ['src/sync/b.ts'], stale: false, clock: 'git' }),
    ]);

    // a.ts was committed after the page last changed.
    const given = await pagesForFiles(opened, { startDir: root, files: [path.join(root, 'src/sync/a.ts'), 'README.md'] });
    expect(given.pages).toEqual([expect.objectContaining({ id: 'page-sync', files: ['src/sync/a.ts'], stale: true, clock: 'git', lastChange: '2026-01-01T00:00:00.000Z' })]);
    // An absolute path through a symlink (macOS /var is /private/var) is the same file.
    const viaLink = path.join(tmpdir(), path.basename(root), 'src/sync/a.ts');
    expect((await pagesForFiles(opened, { startDir: root, files: [viaLink] })).files).toEqual(['src/sync/a.ts']);
    // A file outside the repository is dropped, so even a glob without a slash cannot cover it.
    const outside = await pagesForFiles(opened, { startDir: root, files: [path.join(path.dirname(root), 'elsewhere', 'z.ts')] });
    expect(outside).toEqual({ source: 'given', files: [], pages: [] });

    const first = git(root, ['rev-list', '--max-parents=0', 'HEAD']);
    const since = await pagesForFiles(opened, { startDir: root, since: first });
    expect(since.source).toBe(`since ${first}`);
    expect(since.pages).toEqual([expect.objectContaining({ id: 'page-sync', files: ['src/sync/a.ts'], stale: true })]);
  });

  it('uses the page file mtime for a wiki git does not track, and says so', async () => {
    const { root, opened } = await repo('nimbalyst-local/wiki');
    // initLocalWiki gitignored the private wiki, so its pages have no commits.
    expect(git(root, ['log', '--format=%H', '--', 'nimbalyst-local'])).toBe('');
    const page = path.join(root, 'nimbalyst-local/wiki/Sync protocol.md');
    utimesSync(page, new Date('2025-12-01T00:00:00Z'), new Date('2025-12-01T00:00:00Z'));
    const result = await pagesForFiles(opened, { startDir: root, files: ['src/sync/a.ts'] });
    expect(result.pages).toEqual([expect.objectContaining({ id: 'page-sync', stale: true, clock: 'mtime', lastChange: '2025-12-01T00:00:00.000Z' })]);
  });

  it('refuses a `since` that is not a commit, without passing it to git', async () => {
    const { root, opened } = await repo('docs/wiki');
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'nim-coverage-victim-')));
    dirs.push(outside);
    writeFileSync(path.join(outside, 'victim'), 'keep\n');
    await expect(pagesForFiles(opened, { startDir: root, since: `--output=${path.join(outside, 'victim')}` })).rejects.toThrow(/since/);
    await expect(pagesForFiles(opened, { startDir: root, since: 'no-such-branch' })).rejects.toThrow(/since/);
    expect(readdirSync(outside)).toEqual(['victim']);
  });

  it('sees renamed, non-ASCII and pre-first-commit files in the working tree', async () => {
    const { root, opened } = await repo('docs/wiki');
    // A staged rename out of src/sync still changes src/sync.
    git(root, ['mv', 'src/sync/b.ts', 'b-moved.ts']);
    write(root, 'src/sync/café.ts', 'c\n');
    const working = await pagesForFiles(opened, { startDir: root });
    expect(working.files).toEqual(expect.arrayContaining(['src/sync/b.ts', 'b-moved.ts', 'src/sync/café.ts']));
    expect(working.pages).toEqual([expect.objectContaining({ id: 'page-sync', files: ['src/sync/b.ts', 'src/sync/café.ts'] })]);

    // No commit yet: staged files are still changes.
    const fresh = realpathSync(mkdtempSync(path.join(tmpdir(), 'nim-coverage-unborn-')));
    dirs.push(fresh);
    git(fresh, ['init', '-q']);
    expect(realpathSync(git(fresh, ['rev-parse', '--show-toplevel']))).toBe(fresh);
    const wiki = await initLocalWiki(fresh, path.join(fresh, 'docs/wiki'));
    wikis.push(wiki);
    write(wiki.dir, 'Sync.md', '---\nid: page-sync\npaths: [src/sync/**]\n---\n\nBody.\n');
    write(fresh, 'src/sync/a.ts', 'a\n');
    git(fresh, ['add', 'src']);
    await wiki.wiki.rescan();
    expect((await pagesForFiles(wiki, { startDir: fresh })).pages).toEqual([expect.objectContaining({ id: 'page-sync', files: ['src/sync/a.ts'] })]);
  });

  it('says staleness is unknown in a shallow clone whose history stops at the page', async () => {
    const { root } = await repo('docs/wiki');
    write(root, 'src/sync/a.ts', 'a2\n');
    git(root, ['commit', '-q', '-am', 'two'], '2026-02-01T00:00:00Z');
    const clone = realpathSync(mkdtempSync(path.join(tmpdir(), 'nim-coverage-shallow-')));
    dirs.push(clone);
    execFileSync('git', ['clone', '-q', '--depth', '1', `file://${root}`, clone], { stdio: 'ignore' });
    expect(realpathSync(git(clone, ['rev-parse', '--show-toplevel']))).toBe(clone);
    const opened = await openLocalWiki(clone, path.join(clone, 'docs/wiki'));
    wikis.push(opened);
    const result = await pagesForFiles(opened, { startDir: clone, files: ['src/sync/a.ts'] });
    expect(result.pages).toEqual([expect.objectContaining({ id: 'page-sync', stale: null, clock: 'shallow' })]);
  });

  it('resolves relative inputs and drops any that leave the repository', async () => {
    const { root, opened } = await repo('docs/wiki');
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'nim-coverage-out-')));
    dirs.push(outside);
    symlinkSync(outside, path.join(root, 'src/sync/out'));
    const result = await pagesForFiles(opened, { startDir: root, files: ['src/sync/../../../outside.ts', 'src/sync/out/z.ts', 'src/other/../sync/a.ts'] });
    expect(result.files).toEqual(['src/sync/a.ts']);
    expect(result.pages).toEqual([expect.objectContaining({ id: 'page-sync', files: ['src/sync/a.ts'] })]);
  });

  it('returns nothing outside git when asked for the working tree', async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'nim-coverage-nogit-')));
    dirs.push(root);
    const opened = await initLocalWiki(root);
    wikis.push(opened);
    expect((await pagesForFiles(opened, { startDir: root })).pages).toEqual([]);
  });
});
