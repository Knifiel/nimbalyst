/**
 * What a coding agent is told about the project's local wiki when a session
 * starts (the plugin's SessionStart hook, wikiContextEntry.ts): where it is,
 * what Home and the top-level pages cover, how many open questions it holds,
 * and which pages cover files already changed in the working tree.
 *
 * Read-only (the wiki is opened with repair off) and local only: a session
 * start never waits on the network.
 */
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { MARKER_FILE, openWiki, type LocalPage, type LocalWiki } from '@nimbalyst/local-wiki';
import { findPageMarks } from '@nimbalyst/runtime/core/pageMarkSyntax';
import { DeadlineExceeded, pagesForFiles } from '../localWiki/coverage.js';
import { readMigratedTo, resolveWikiLocation } from '../localWiki/locate.js';
import { typesDir } from '../localWiki/open.js';

/** Context hosts add to the agent's prompt on every session; keep it to a few hundred tokens. */
export const CONTEXT_MAX_CHARS = 1500;
/** Bodies read for the open-question count; a bigger wiki reports a lower bound. */
const MAX_BODIES = 400;
/**
 * How long the session hooks spend before giving up and saying nothing. Their
 * host timeout is 10s; this leaves room for Node to start and the wiki scan.
 */
export const HOOK_DEADLINE_MS = 3000;

export interface WikiContextOptions {
  /** Wall-clock ms after which the context is abandoned: the result is null. */
  deadline?: number;
}

/** What the agent is told instead of the local wiki once it moved to a team project. */
export function movedNotice(folder: string, at: string): string {
  return (
    `This project's local wiki (${folder}) was moved to a Nimbalyst Teams project${at ? ` on ${at.slice(0, 10)}` : ''}; the local files are an archive. ` +
    'Read and write the team wiki with the nimbalyst-team tools (see /nimbalyst-wiki:connect), not the local ones.'
  );
}

/** The local wiki for `startDir`, opened read-only; null when there is none. */
export async function openWikiReadOnly(startDir: string): Promise<{ dir: string; projectRoot: string; wiki: LocalWiki } | null> {
  const where = resolveWikiLocation(startDir);
  if (!existsSync(path.join(where.dir, MARKER_FILE))) return null;
  const wiki = await openWiki(where.dir, { typesDir: typesDir(where.projectRoot), repair: false });
  return { dir: where.dir, projectRoot: where.projectRoot, wiki };
}

/** Open-question marks (`[text]{open ...}`), read with the app's parser. */
export function countOpenQuestions(markdown: string): number {
  return findPageMarks(markdown).filter((mark) => mark.kind === 'open').length;
}

const summaryOf = (page: LocalPage) => (typeof page.fields.summary === 'string' ? page.fields.summary.trim() : '');
const byOrder = (a: LocalPage, b: LocalPage) => (a.order ?? Infinity) - (b.order ?? Infinity) || a.title.localeCompare(b.title);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export async function buildWikiContext(startDir: string, maxChars = CONTEXT_MAX_CHARS, options: WikiContextOptions = {}): Promise<string | null> {
  try {
    return await contextText(startDir, maxChars, options.deadline);
  } catch (err) {
    if (err instanceof DeadlineExceeded) return null;
    throw err;
  }
}

async function contextText(startDir: string, maxChars: number, deadline?: number): Promise<string | null> {
  const overdue = () => {
    if (deadline !== undefined && Date.now() >= deadline) throw new DeadlineExceeded();
  };
  overdue();
  const opened = await openWikiReadOnly(startDir);
  if (!opened) return null;
  try {
    const folder = path.relative(opened.projectRoot, opened.dir).split(path.sep).join('/') || '.';
    const moved = readMigratedTo(opened.projectRoot);
    if (moved) return movedNotice(folder, moved.at);
    overdue();
    const { pages } = await opened.wiki.snapshot();
    const live = pages.filter((page) => page.trashedAt === null && !page.malformed);
    const topLevel = live.filter((page) => page.parentId === null && page.type === null).sort(byOrder);
    const home = topLevel.find((page) => page.title.toLowerCase() === 'home') ?? topLevel[0];

    let open = 0;
    for (const page of live.filter((p) => p.documentType === 'markdown' && p.hasContent).slice(0, MAX_BODIES)) {
      overdue();
      open += countOpenQuestions((await opened.wiki.readBody(page.id)).markdown);
    }
    const covered = (await pagesForFiles(opened, { startDir, deadline })).pages;
    const head = [`This project has a local wiki in ${folder} (${plural(live.length, 'page')}), read and written with the nimbalyst-local wiki tools.`];
    if (home) head.push(`${home.title}: ${summaryOf(home) || 'no summary yet.'}`);
    const tail: string[] = [];
    if (covered.length > 0) {
      const names = covered.slice(0, 5).map((page) => (page.stale ? `${page.title} (stale)` : page.title));
      tail.push(`Pages that cover files changed in the working tree: ${names.join(', ')}${covered.length > 5 ? `, and ${covered.length - 5} more` : ''}. Read them before continuing that work.`);
    }
    if (open > 0) tail.push(`${plural(open, 'open question')} marked in the wiki.`);
    tail.push(
      'Before design or a change in an area, searchPages for it and read what matches; pagesForFiles lists the pages covering given files. ' +
        'After deciding something or changing covered code, follow /nimbalyst-wiki:capture.',
    );

    const fixed = [...head, ...tail].join('\n').length + 1;
    const lines: string[] = [];
    const rest = topLevel.filter((page) => page !== home);
    let used = fixed;
    let shown = 0;
    for (const page of rest) {
      const summary = summaryOf(page);
      const line = `- ${page.title}${summary ? `: ${summary}` : ''}`;
      const more = `- and ${rest.length - shown - 1} more top-level pages`;
      // Leave room for the "and N more" line unless this is the last page.
      const need = line.length + 1 + (shown + 1 < rest.length ? more.length + 1 : 0);
      if (used + (lines.length === 0 ? 'Top-level pages:'.length + 1 : 0) + need > maxChars) break;
      if (lines.length === 0) {
        lines.push('Top-level pages:');
        used += lines[0].length + 1;
      }
      lines.push(line);
      used += line.length + 1;
      shown++;
    }
    if (shown < rest.length && lines.length > 0) lines.push(`- and ${rest.length - shown} more top-level pages`);
    const text = [...head, ...lines, ...tail].join('\n');
    return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
  } finally {
    opened.wiki.close();
  }
}
