/**
 * The wiki's type definitions in the tracker registry the UI reads.
 *
 * The UI's selectors read the process-wide registry, which the bundle fills
 * through `BrowserTrackerSchemaStore`. That store refuses `sharing: personal`
 * types (no team room carries them), so local types are registered with the
 * team lane's sharing; nothing here talks to a team.
 */
import { BrowserTrackerSchemaStore, parseBuiltinTrackers } from '@nimbalyst/collab-bundle/trackers-ui';
import type { WikiTypeInfo } from '../api/client';

const NOT_A_TABLE_COLUMN = new Set(['description', 'created', 'updated']);

/**
 * The table shows only role fields and `tableView.defaultColumns` by default,
 * and wiki type files rarely declare either, so a type's own fields would be
 * hidden with no way here to add them. A file that lists its columns keeps them.
 */
function tableView(definition: Record<string, unknown>, fields: unknown[], titleField: string): Record<string, unknown> {
  const declared = (definition.tableView as Record<string, unknown> | undefined) ?? {};
  if (Array.isArray(declared.defaultColumns)) return declared;
  const defaultColumns = fields
    .map((field) => (field && typeof field === 'object' ? (field as { name?: unknown }).name : null))
    .filter((name): name is string => typeof name === 'string' && name !== titleField && !NOT_A_TABLE_COLUMN.has(name));
  return { ...declared, defaultColumns };
}

export function modelJson(type: WikiTypeInfo): string {
  const definition = type.definition ?? {};
  const fields = Array.isArray(definition.fields) ? definition.fields : type.fields;
  return JSON.stringify({
    icon: 'label',
    color: '#6b7280',
    ...definition,
    type: type.typeId,
    displayName: type.displayName,
    displayNamePlural: type.displayNamePlural,
    fields,
    tableView: tableView(definition, fields, type.titleField),
    roles: { ...((definition.roles as Record<string, unknown> | undefined) ?? {}), title: type.titleField },
    modes: { inline: true, fullDocument: type.storage === 'pages' },
    idPrefix: typeof definition.idPrefix === 'string' ? definition.idPrefix : type.typeId.slice(0, 3),
    idFormat: 'ulid',
    sharing: 'team',
  });
}

export async function loadWikiSchema(types: readonly WikiTypeInfo[]): Promise<BrowserTrackerSchemaStore> {
  const store = new BrowserTrackerSchemaStore({
    builtins: parseBuiltinTrackers(),
    reportError: (error, where) => console.error(`[wiki-web] ${where}`, error),
  });
  await applyWikiTypes(store, [], types);
  return store;
}

/** Registers `next` and unregisters the types `previous` had that `next` does not. */
export async function applyWikiTypes(store: BrowserTrackerSchemaStore, previous: readonly WikiTypeInfo[], next: readonly WikiTypeInfo[]): Promise<void> {
  for (const type of next) {
    await store.schemaSync.applyRemote({ type: type.typeId, model: modelJson(type), syncId: 0 });
  }
  const kept = new Set(next.map((type) => type.typeId));
  for (const type of previous) {
    if (!kept.has(type.typeId)) await store.schemaSync.applyRemote({ type: type.typeId, model: null, syncId: 0 });
  }
}
