/**
 * `listMarks` (local only): decision and open-question marks across the local
 * wiki. See localWiki/marks.ts.
 */
import { readMigratedTo } from '../localWiki/locate.js';
import { listMarks, MARKS_DEFAULT_LIMIT } from '../localWiki/marks.js';
import { localTool, str, type LocalWikiContext } from './localTools.js';
import type { McpTool } from './toolMap.js';

export const LIST_MARKS_TOOL = 'listMarks';

const MOVED_NOTE =
  'This local wiki was moved to a Nimbalyst Teams project; these marks come from the archive left behind and may be out of date. Ask the team wiki (nimbalyst-team) for current decisions.';

export function marksTool(context: LocalWikiContext): McpTool {
  return localTool(
    {
      name: LIST_MARKS_TOOL,
      description:
        'List the decisions and open questions marked in the local wiki\'s pages (`[sentence]{decided by=... on=... over=...}` and `[sentence]{open by=...}`), with the page id and title, line (in the body readCollabDoc returns), kind, by, email, on, over and the sentence as plain text. ' +
        'The first call for "what did we decide about X", "why did we", or "what is still open": filter by `query` words, `kind` or `by`, then read the pages it names for the reasoning around a mark. ' +
        '`total` counts every match; at most `limit` are returned.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['decided', 'open'], description: 'Only decisions, or only open questions. Default: both.' },
          by: { type: 'string', description: 'Part of the name or email of who decided or owns the question, any case.' },
          query: { type: 'string', description: 'Words that must all appear in the sentence, what it was chosen over, or the page title.' },
          limit: { type: 'number', description: `Most marks to return. Default ${MARKS_DEFAULT_LIMIT}.` },
        },
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    context,
    async (opened, args) => {
      const kind = args.kind === 'decided' || args.kind === 'open' ? args.kind : undefined;
      const result = await listMarks(opened, {
        kind,
        by: str(args, 'by'),
        query: str(args, 'query'),
        limit: typeof args.limit === 'number' && args.limit > 0 ? args.limit : undefined,
      });
      // After a move to Teams the local pages are the archive it was copied from, not what the team decided since.
      const moved = readMigratedTo(opened.projectRoot);
      return moved ? { movedToTeam: { ...moved, note: MOVED_NOTE }, ...result } : result;
    },
  );
}
