/**
 * The nimbalyst-wiki plugin's SessionStart hook (Claude Code), bundled into
 * plugins/nimbalyst-wiki/scripts/wiki-context.mjs by
 * scripts/build-wiki-plugin.mjs. With a local wiki in the project it prints
 * `hookSpecificOutput.additionalContext` (see wikiContext.ts); with none, or on
 * any failure, it prints nothing and exits 0, so a broken hook never blocks a
 * session.
 *
 * The Stop hook (scripts/keeper-nudge.mjs) imports `coveredPages` from the
 * same bundle, so both hooks read page coverage one way.
 */
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pagesForFiles } from '../localWiki/coverage.js';
import { readMigratedTo } from '../localWiki/locate.js';
import { buildWikiContext, HOOK_DEADLINE_MS, openWikiReadOnly } from './wikiContext.js';

/**
 * The local wiki pages covering `files` (absolute or repository-relative), or
 * the working tree's changes when `files` is empty. Empty without a wiki or
 * once it moved to a team project. Throws DeadlineExceeded past `deadline`;
 * the Stop hook treats that as none.
 */
export async function coveredPages(startDir: string, files: string[] = [], deadline = Date.now() + HOOK_DEADLINE_MS): Promise<Array<{ title: string; stale: boolean | null }>> {
  const opened = await openWikiReadOnly(startDir);
  if (!opened) return [];
  try {
    if (readMigratedTo(opened.projectRoot)) return [];
    const { pages } = await pagesForFiles(opened, { startDir, files, deadline });
    return pages.map(({ title, stale }) => ({ title, stale }));
  } finally {
    opened.wiki.close();
  }
}

function projectDir(input: unknown): string {
  const fromEnv = process.env.CLAUDE_PROJECT_DIR;
  if (fromEnv) return fromEnv;
  const cwd = input && typeof input === 'object' ? (input as { cwd?: unknown }).cwd : undefined;
  return typeof cwd === 'string' && cwd ? cwd : process.cwd();
}

async function main(): Promise<void> {
  // stdout is the hook's answer; anything a dependency logs goes to stderr.
  console.log = console.error;
  let input: unknown = {};
  try {
    input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    // no input, or not JSON: fall back to the environment and cwd
  }
  const text = await buildWikiContext(projectDir(input), undefined, { deadline: Date.now() + HOOK_DEADLINE_MS });
  if (text) process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } })}\n`);
}

const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  process.on('uncaughtException', () => process.exit(0));
  main().then(
    () => process.exit(0),
    () => process.exit(0),
  );
}
