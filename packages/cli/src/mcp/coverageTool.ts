/**
 * `pagesForFiles` (local only): the wiki pages whose `paths` cover a set of
 * files, by default the working tree's changes. See localWiki/coverage.ts.
 */
import { pagesForFiles } from '../localWiki/coverage.js';
import { localTool, str, type LocalWikiContext } from './localTools.js';
import type { McpTool } from './toolMap.js';

export const PAGES_FOR_FILES_TOOL = 'pagesForFiles';

export function coverageTool(context: LocalWikiContext): McpTool {
  return localTool(
    {
      name: PAGES_FOR_FILES_TOOL,
      description:
        "List the local wiki pages that cover a set of files, through each page's `paths` field (repository-relative globs). " +
        'With no `files`, checks the working tree: uncommitted and untracked changes, or with `since` (a git ref) the files changed in `<since>...HEAD`. ' +
        'Each page comes with the files it matched and `stale: true` when one of them has a commit newer than the page; `clock` says whether the page was dated by its own last commit (`git`) or, for a wiki git does not track, its file time (`mtime`, reset by a checkout). ' +
        'Call it before changing code, to read the pages that explain it, and after, to update or flag the pages the change affects.',
      inputSchema: {
        type: 'object',
        properties: {
          files: { type: 'array', items: { type: 'string' }, description: 'Files to check, absolute or relative to the repository root. Default: the working tree changes.' },
          since: { type: 'string', description: 'A git ref (branch, tag or commit). Checks the files changed since it instead of the working tree.' },
        },
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    context,
    async (opened, args) => {
      const files = Array.isArray(args.files) ? args.files.filter((file): file is string => typeof file === 'string' && file.trim().length > 0) : undefined;
      return pagesForFiles(opened, { startDir: context.workspace().startDir, files, since: str(args, 'since') });
    },
  );
}
