// @vitest-environment node
/**
 * The Home page `initLocalWiki` writes is starter text: the setup skill must
 * recognize it to replace it rather than append below it, and the local wiki
 * browser must be able to show it before any other page exists.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initLocalWiki, type OpenedWiki } from '../open.js';

const SETUP_SKILL = fileURLToPath(new URL('../../../../extensions/knowledge/skills-source/setup/SKILL.md', import.meta.url));

const dirs: string[] = [];
const wikis: OpenedWiki[] = [];
afterEach(() => {
  for (const opened of wikis.splice(0)) opened.wiki.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function init(project: string): Promise<{ homeId: string | null; home: string; pages: number }> {
  const result = await initLocalWiki(project);
  wikis.push(result);
  const live = (await result.wiki.snapshot()).pages.filter((page) => page.trashedAt === null);
  const homeId = live.find((page) => page.title === 'Home')?.id;
  return { homeId: result.homeId, home: homeId ? (await result.wiki.readBody(homeId)).markdown : '', pages: live.length };
}

describe('initLocalWiki Home', () => {
  it('writes starter text the setup skill replaces, which the local browser can show', async () => {
    const project = realpathSync(mkdtempSync(path.join(tmpdir(), 'nim-init-home-')));
    dirs.push(project);
    const first = await init(project);
    expect(first.homeId).not.toBeNull();
    expect(first.pages).toBe(1);

    // Setup finds the starter Home by its opening sentence.
    const opening = first.home.split('\n')[0].trim();
    expect(opening.length).toBeGreaterThan(20);
    expect(readFileSync(SETUP_SKILL, 'utf8')).toContain(opening);

    // Nothing to link to yet, and nothing the local browser refuses to show.
    expect(first.home).not.toMatch(/\]\(/);
    expect(first.home).not.toMatch(/```board-table|\$\$/);
    expect(first.home.replace(/<details data-tab>/g, '')).not.toContain('<details');

    // A second run leaves the wiki as it is.
    const again = await init(project);
    expect(again.homeId).toBeNull();
    expect(again.pages).toBe(1);
    expect(again.home).toBe(first.home);
  });
});
