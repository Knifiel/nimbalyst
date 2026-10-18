/**
 * `wikiDoctor` (local only): what is wrong with the wiki, grouped and capped.
 * Read-only; see localWiki/doctor.ts.
 */
import { DOCTOR_DEFAULT_LIMIT, wikiDoctor } from '../localWiki/doctor.js';
import { localTool, str, type LocalWikiContext } from './localTools.js';
import type { McpTool } from './toolMap.js';

export const WIKI_DOCTOR_TOOL = 'wikiDoctor';

/** `versions` is the running server's version report (update/installs.ts), shown first in the result. */
export function doctorTool(context: LocalWikiContext, versions?: () => unknown): McpTool {
  return localTool(
    {
      name: WIKI_DOCTOR_TOOL,
      description:
        'Check the local wiki and report what needs fixing, without changing anything. Groups: `issues` (what the folder scan found: broken links, duplicate ids, malformed files and the like), ' +
        '`orphans` (plain pages no other page links to, other than Home), `stale` (pages whose `paths` cover files committed on the default branch after the page last changed), ' +
        '`duplicateTitles` (titles equal after folding case, punctuation and plurals) and `deadPaths` (pages with `status: current` whose `paths` match no file). ' +
        'Each group has a total and at most `limit` entries; `summary` has the counts. Call it after a large rework and before calling the wiki tidy, then fix with the ordinary page tools. ' +
        '`versions` says which nim and browser app this server runs, how they were installed, the latest version known, whether a restart is needed, and the wiki plugins installed for Claude Code and Codex: use it to answer which version is in use.',
      inputSchema: {
        type: 'object',
        properties: {
          base: { type: 'string', description: 'Branch or ref the stale check compares with. Default: the default branch (origin/HEAD, else main or master).' },
          limit: { type: 'number', description: `Entries per group. Default ${DOCTOR_DEFAULT_LIMIT}.` },
        },
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    context,
    async (opened, args) => {
      const report = await wikiDoctor(opened, {
        startDir: context.workspace().startDir,
        base: str(args, 'base'),
        limit: typeof args.limit === 'number' && args.limit > 0 ? args.limit : undefined,
      });
      return versions ? { versions: versions(), ...report } : report;
    },
  );
}
