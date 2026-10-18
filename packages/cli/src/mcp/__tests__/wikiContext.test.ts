// @vitest-environment node
/**
 * The SessionStart context: what an agent is told about the local wiki before
 * its first prompt. Nothing without a wiki, never more than the cap.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { writeMigratedTo } from '../../localWiki/locate.js';
import { initLocalWiki } from '../../localWiki/open.js';
import { buildWikiContext, CONTEXT_MAX_CHARS } from '../wikiContext.js';
import { coveredPages } from '../wikiContextEntry.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function project(): Promise<{ root: string; wiki: string }> {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'nim-context-')));
  dirs.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  // Sandboxed: git runs in the temp repository, never this checkout.
  expect(realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' }).trim())).toBe(root);
  (await initLocalWiki(root)).wiki.close();
  const wiki = path.join(root, 'nimbalyst-local', 'wiki');
  return { root, wiki };
}

function page(wiki: string, name: string, frontmatter: string, body = 'Body.\n'): void {
  writeFileSync(path.join(wiki, `${name}.md`), `---\n${frontmatter}\n---\n\n${body}`);
}

describe('buildWikiContext', () => {
  it('is null for a project with no local wiki', async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'nim-context-none-')));
    dirs.push(root);
    expect(await buildWikiContext(root)).toBeNull();
  });

  it('names the folder, Home, top-level pages, open questions and the pages covering current changes', async () => {
    const { root, wiki } = await project();
    const home = readdirSync(wiki).find((name) => name === 'Home.md');
    expect(home).toBe('Home.md');
    page(wiki, 'Home', 'id: home\nsummary: Where the widget project keeps its decisions.');
    page(wiki, 'Sync protocol', 'id: sync\nsummary: How clients sync.\npaths: [src/sync/**]', '[Do we batch acks?]{open by="Spike 2"}\n\nAnd [retries]{open}.\n\n`[not]{open}` in code.\n');
    page(wiki, 'Glossary', 'id: glossary');
    mkdirSync(path.join(root, 'src', 'sync'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'sync', 'a.ts'), 'a\n');

    const text = (await buildWikiContext(root))!;
    expect(text).toContain('nimbalyst-local/wiki');
    expect(text).toContain('Home: Where the widget project keeps its decisions.');
    expect(text).toContain('- Sync protocol: How clients sync.');
    expect(text).toContain('- Glossary');
    expect(text).toContain('2 open questions');
    expect(text).toMatch(/cover files changed in the working tree: Sync protocol/);
    expect(text).toContain('/nimbalyst-wiki:capture');
    expect(text.length).toBeLessThanOrEqual(CONTEXT_MAX_CHARS);
  });

  it('answers within its time bound on a large wiki whose pages all cover the changed files, and gives up past the deadline', { timeout: 60_000 }, async () => {
    const { root, wiki } = await project();
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    for (let i = 0; i < 150; i++) page(wiki, `Area ${String(i).padStart(3, '0')}`, `id: area-${i}\npaths: [src/**]`);
    mkdirSync(path.join(root, 'src'), { recursive: true });
    for (let i = 0; i < 20; i++) writeFileSync(path.join(root, 'src', `f${i}.ts`), `${i}\n`);
    execFileSync('git', ['add', 'src'], { cwd: root });
    execFileSync('git', ['commit', '-q', '-m', 'one'], { cwd: root });
    for (let i = 0; i < 20; i++) writeFileSync(path.join(root, 'src', `f${i}.ts`), `${i} changed\n`);

    const started = Date.now();
    const text = (await buildWikiContext(root))!;
    const elapsed = Date.now() - started;
    expect(text).toMatch(/cover files changed in the working tree: Area 000/);
    expect(elapsed).toBeLessThan(3000);
    // Past its deadline the hook says nothing rather than run on.
    expect(await buildWikiContext(root, CONTEXT_MAX_CHARS, { deadline: Date.now() })).toBeNull();
  });

  it('after a move to Teams, points at the team wiki and says nothing about the local archive', async () => {
    const { root, wiki } = await project();
    page(wiki, 'Sync protocol', 'id: sync\npaths: [src/sync/**]');
    mkdirSync(path.join(root, 'src', 'sync'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'sync', 'a.ts'), 'a\n');
    expect(await coveredPages(root)).toEqual([{ title: 'Sync protocol', stale: false }]);
    writeMigratedTo(root, { orgId: 'org-1', projectId: 'proj-1', at: '2026-10-15T00:00:00.000Z' });
    const text = (await buildWikiContext(root))!;
    expect(text).toMatch(/moved to a Nimbalyst Teams project/);
    expect(text).not.toContain('Sync protocol');
    expect(text.split('\n')).toHaveLength(1);
    expect(await coveredPages(root)).toEqual([]);
  });

  it('stays under the cap on a large wiki and says how many pages it left out', async () => {
    const { root, wiki } = await project();
    for (let i = 0; i < 120; i++) page(wiki, `Topic ${String(i).padStart(3, '0')}`, `id: topic-${i}\nsummary: ${'A long summary of this topic. '.repeat(6).trim()}`);
    const text = (await buildWikiContext(root))!;
    expect(text.length).toBeLessThanOrEqual(CONTEXT_MAX_CHARS);
    expect(text).toContain('- Topic 000');
    expect(text).toMatch(/and \d+ more top-level pages/);
    expect(text).toContain('/nimbalyst-wiki:capture');
  });
});
