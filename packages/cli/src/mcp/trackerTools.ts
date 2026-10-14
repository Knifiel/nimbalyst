/**
 * Tracker tools for the types placed in the local wiki: typed pages (markdown
 * with `type:` in frontmatter) and table types (one CSV per type). Bugs, tasks
 * and other app-database types are not here; the desktop app serves those.
 * The item logic is shared with `nim tracker` (localWiki/trackerItems.ts).
 */
import { localPageUri } from '../localWiki/tree.js';
import { createItem, findItem, listItems, summarize, updateItem, wikiTypes, type WhereFilter } from '../localWiki/trackerItems.js';
import { contractDefinition, localTool, requireStr, str, type Args, type LocalWikiContext } from './localTools.js';
import type { McpTool } from './toolMap.js';
import type { WikiIssue } from '@nimbalyst/local-wiki';
import { usageError } from '../cli/exitCodes.js';

export const CONVERT_TOOL_NAME = 'convertTypeStorage';

const ITEM_REFS = { issueKeys: ['id'], refKeys: ['id'] };

/** The standard tracker arguments folded into a field patch. */
function fieldPatch(args: Args): Record<string, unknown> {
  const patch: Record<string, unknown> = { ...((args.fields && typeof args.fields === 'object' ? args.fields : {}) as Record<string, unknown>) };
  for (const key of ['status', 'priority', 'owner']) if (typeof args[key] === 'string') patch[key] = args[key];
  if (Array.isArray(args.tags)) patch.tags = args.tags;
  return patch;
}

/** Type-file problems an agent must fix (a reserved field name), on the type they belong to. */
function problems(issues: WikiIssue[], sourcePath: string | undefined): { problems?: string[] } {
  const mine = sourcePath ? issues.filter((issue) => issue.path === sourcePath).map((issue) => issue.message) : [];
  return mine.length > 0 ? { problems: mine } : {};
}

/** Local-only: the team wiki has no table storage, so the shared contract has no conversion tool. */
function convertTool(context: LocalWikiContext): McpTool {
  return localTool(
    {
      name: CONVERT_TOOL_NAME,
      description:
        "Convert a table type (all items in one CSV) to page storage: one markdown page per item, in the CSV's folder, each with a body and room for child pages. " +
        'Item ids and field values are kept; the CSV goes to the wiki trash and the type file changes to `storage: pages`. Only table-to-pages is supported.',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', description: 'The type id, as in tracker_list_types.' },
          storage: { type: 'string', enum: ['pages'], description: "The storage to convert to. Only 'pages'." },
        },
        required: ['type', 'storage'],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    context,
    async ({ wiki }, args) => {
      const typeId = requireStr(args, 'type');
      if (requireStr(args, 'storage') !== 'pages') throw usageError("Only conversion to 'pages' is supported; a page type is not turned back into a table.");
      const result = await wiki.convertTableToPages(typeId);
      return { type: typeId, storage: 'pages', converted: result.created };
    },
  );
}

export function trackerTools(context: LocalWikiContext): McpTool[] {
  return [
    localTool(
      contractDefinition('tracker_list_types', "List the types placed in the local wiki, with their fields and storage ('pages': one markdown page per item; 'table': one CSV)."),
      context,
      async ({ wiki }, args) => {
        const defs = new Map(wiki.typeDefs().map((def) => [def.typeId, def]));
        const issues = (await wiki.snapshot()).issues.filter((issue) => issue.code === 'reserved-field');
        const search = str(args, 'search')?.toLowerCase();
        const types = [];
        for (const typeId of await wikiTypes(wiki)) {
          const def = defs.get(typeId);
          if (search && !typeId.toLowerCase().includes(search) && !def?.displayName.toLowerCase().includes(search)) continue;
          const snapshot = await wiki.trackerSnapshot(typeId);
          types.push({
            type: typeId,
            displayName: def?.displayName ?? typeId,
            storage: snapshot.storage,
            fields: def?.fields ?? [],
            defined: Boolean(def),
            itemCount: snapshot.items.length,
            ...problems(issues, def?.sourcePath),
          });
        }
        return { types };
      },
    ),
    localTool(
      contractDefinition(
        'tracker_list',
        'List typed pages and table rows in the local wiki, with optional filters. Only open items are returned unless includeClosed is set or a closed status is asked for.',
        { drop: ['archived', 'statusCategory'] },
      ),
      context,
      async ({ wiki }, args) => {
        const items = await listItems(wiki, {
          type: str(args, 'type'),
          status: str(args, 'status'),
          includeClosed: args.includeClosed === true,
          priority: str(args, 'priority'),
          owner: str(args, 'owner'),
          search: str(args, 'search'),
          where: Array.isArray(args.where) ? (args.where as WhereFilter[]) : undefined,
          whereCombinator: args.whereCombinator === 'or' ? 'or' : 'and',
        });
        const limit = Math.min(typeof args.limit === 'number' ? args.limit : 50, 250);
        return { items: items.slice(0, limit).map((i) => summarize(i, args.full === true)), total: items.length };
      },
    ),
    localTool(
      contractDefinition('tracker_get', 'Get one typed page or table row from the local wiki: its fields, and for a typed page its markdown body and body version.'),
      context,
      async ({ wiki }, args) => {
        const item = await findItem(wiki, requireStr(args, 'id'));
        if (item.storage === 'table') return summarize(item, true);
        const body = await wiki.readBody(item.id);
        return { ...summarize(item, true), version: body.version, markdown: body.markdown };
      },
      ITEM_REFS,
    ),
    localTool(
      contractDefinition(
        'tracker_create',
        "Create a typed page (a markdown file with the type in its frontmatter) or, for a table type, a CSV row. Local items have ids, not issue keys. `description` is the body; table types have none. Never create an item already marked done.",
        { extra: { parentId: { type: 'string', description: 'Local wiki only, page types: the page to create it under (default the top of the wiki).' } } },
      ),
      context,
      async ({ wiki }, args) => {
        const item = await createItem(wiki, requireStr(args, 'type'), {
          title: requireStr(args, 'title'),
          fields: fieldPatch(args),
          parentId: str(args, 'parentId') ?? null,
          body: typeof args.description === 'string' ? args.description : undefined,
        });
        return { itemId: item.id, path: item.path, ...(item.storage === 'pages' ? { uri: localPageUri(item.id) } : {}) };
      },
    ),
    localTool(
      contractDefinition(
        'tracker_update',
        "Update a local typed page or table row: title, fields (null or unsetFields clears one), and for a typed page its body (`description` replaces it) or its type (`primaryType`).",
        { drop: ['expectedRevision', 'archived'] },
      ),
      context,
      async ({ wiki }, args) => {
        const updates: Record<string, unknown> = fieldPatch(args);
        if (Array.isArray(args.unsetFields)) for (const name of args.unsetFields) updates[String(name)] = null;
        if (typeof args.title === 'string') updates.title = args.title;
        const item = await updateItem(wiki, requireStr(args, 'id'), {
          updates,
          body: typeof args.description === 'string' ? args.description : undefined,
          primaryType: str(args, 'primaryType'),
        });
        return summarize(item, true);
      },
      ITEM_REFS,
    ),
    convertTool(context),
  ];
}
