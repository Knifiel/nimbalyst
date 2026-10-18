// @vitest-environment node
/**
 * `wikiDoctor`: scan issues, orphans, pages stale against the default branch,
 * near-duplicate titles and `current` pages whose `paths` match nothing. Runs
 * in a temp git repository with fixed commit dates.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { initLocalWiki, openLocalWiki, type OpenedWiki } from '../open.js';
import { titleKey, wikiDoctor } from '../doctor.js';

const dirs: string[] = [];
const wikis: OpenedWiki[] = [];
afterEach(() => {
  for (const opened of wikis.splice(0)) opened.wiki.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[], date?: string): string {
  const env = date ? { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : process.env;
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function write(root: string, rel: string, text: string): void {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text);
}

describe('titleKey', () => {
  it('folds case, punctuation and plurals', () => {
    expect(titleKey('Sync Protocols')).toBe(titleKey('sync-protocol'));
    expect(titleKey('Libraries')).toBe(titleKey('library'));
    expect(titleKey('CLI: commands!')).toBe(titleKey('cli command'));
    expect(titleKey('Access')).not.toBe(titleKey('Acces'));
    expect(titleKey('Sync')).not.toBe(titleKey('Async'));
  });
});

describe('wikiDoctor', () => {
  it('reports issues, orphans, stale pages, duplicate titles and dead paths', async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'nim-doctor-')));
    dirs.push(root);
    git(root, ['init', '-q', '-b', 'main']);
    // Sandboxed: every git command below runs in the temp repository, never this checkout.
    expect(realpathSync(git(root, ['rev-parse', '--show-toplevel']))).toBe(root);
    git(root, ['config', 'user.email', 'test@example.com']);
    git(root, ['config', 'user.name', 'Test']);
    const wikiDir = path.join(root, 'docs/wiki');
    const init = await initLocalWiki(root, wikiDir);
    init.wiki.close();
    write(wikiDir, 'Home.md', `---\nid: ${init.homeId}\n---\n\nSee [Sync](Sync%20protocol.md "id=page-sync") and [Gone](Old%20module.md "id=page-old").\n`);
    write(wikiDir, 'Sync protocol.md', '---\nid: page-sync\nstatus: current\npaths: [src/sync/**]\n---\n\nHow sync works. [Missing](Missing.md "id=no-such-page")\n');
    write(wikiDir, 'Sync Protocols.md', '---\nid: page-sync-2\n---\n\nA second take.\n');
    write(wikiDir, 'Old module.md', '---\nid: page-old\nstatus: current\npaths: [src/gone/**]\n---\n\nGone.\n');
    write(wikiDir, 'Draft idea.md', '---\nid: page-draft\nstatus: draft\npaths: [src/later/**]\n---\n\nNot built yet.\n');
    write(root, 'src/sync/a.ts', 'a\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'one'], '2026-01-01T00:00:00Z');
    write(root, 'src/sync/a.ts', 'a2\n');
    git(root, ['commit', '-q', '-am', 'two'], '2026-02-01T00:00:00Z');

    const opened = await openLocalWiki(root, wikiDir);
    wikis.push(opened);
    const report = await wikiDoctor(opened, { startDir: root });

    expect(report.issues.byCode).toEqual({ 'broken-link': 1 });
    expect(report.issues.items).toEqual([expect.objectContaining({ code: 'broken-link', path: 'Sync protocol.md' })]);
    // Home and pages linked from another page are not orphans.
    expect(report.orphans.pages.map((page) => page.id).sort()).toEqual(['page-draft', 'page-sync-2']);
    expect(report.stale.base).toBe('main');
    expect(report.stale.pages).toEqual([
      expect.objectContaining({ id: 'page-sync', files: ['src/sync/a.ts'], clock: 'git', lastChange: '2026-01-01T00:00:00.000Z', fileChange: '2026-02-01T00:00:00.000Z' }),
    ]);
    expect(report.duplicateTitles.groups).toEqual([
      [expect.objectContaining({ id: 'page-sync', title: 'Sync protocol' }), expect.objectContaining({ id: 'page-sync-2', title: 'Sync Protocols' })],
    ]);
    // Only a `current` page claims its code exists; a draft may name code still to come.
    expect(report.deadPaths.pages).toEqual([{ id: 'page-old', title: 'Old module', path: 'Old module.md', paths: ['src/gone/**'] }]);
    expect(report.summary).toEqual({ issues: 1, orphans: 2, stale: 1, duplicateTitles: 1, deadPaths: 1 });
  });

  it('counts a tracked file deleted from disk as gone, and refuses a base that is not a commit', async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'nim-doctor-gone-')));
    dirs.push(root);
    git(root, ['init', '-q', '-b', 'main']);
    expect(realpathSync(git(root, ['rev-parse', '--show-toplevel']))).toBe(root);
    git(root, ['config', 'user.email', 'test@example.com']);
    git(root, ['config', 'user.name', 'Test']);
    const opened = await initLocalWiki(root, path.join(root, 'docs/wiki'));
    wikis.push(opened);
    write(opened.dir, 'Importer.md', '---\nid: page-importer\nstatus: current\npaths: [src/importer/**]\n---\n\nThe importer.\n');
    write(root, 'src/importer/a.ts', 'a\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'one']);
    unlinkSync(path.join(root, 'src/importer/a.ts'));
    await opened.wiki.rescan();
    const report = await wikiDoctor(opened, { startDir: root });
    expect(report.deadPaths.pages.map((page) => page.id)).toEqual(['page-importer']);

    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'nim-doctor-victim-')));
    dirs.push(outside);
    const probe = await wikiDoctor(opened, { startDir: root, base: `--output=${path.join(outside, 'victim')}` });
    expect(probe.stale).toEqual({ base: null, total: 0, pages: [], note: expect.stringContaining('is not a commit') });
    expect(readdirSync(outside)).toEqual([]);
  });

  it('caps each group and keeps the totals', async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'nim-doctor-cap-')));
    dirs.push(root);
    const opened = await initLocalWiki(root);
    wikis.push(opened);
    for (let i = 0; i < 5; i++) write(opened.dir, `Lonely ${i}.md`, `---\nid: lonely-${i}\n---\n\nNo links here.\n`);
    await opened.wiki.rescan();
    const report = await wikiDoctor(opened, { startDir: root, limit: 2 });
    expect(report.orphans.total).toBe(5);
    expect(report.orphans.pages).toHaveLength(2);
    // Outside git there is no branch to compare with or files to match, and the report says so.
    expect(report.stale).toEqual({ base: null, total: 0, pages: [], note: expect.stringContaining('git') });
    expect(report.deadPaths.note).toEqual(expect.stringContaining('git'));
  });
});
