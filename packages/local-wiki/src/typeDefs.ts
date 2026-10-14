import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import yaml from 'js-yaml';
import { contentVersion } from './ids.js';
import type { WikiIssue } from './types.js';

/**
 * The slice of a tracker type definition (`.nimbalyst/trackers/*.yaml`) the
 * library needs. The full model lives in `@nimbalyst/tracker-schema`; this
 * reader stays dependency-free so `nim` can load it without the app.
 */
export interface WikiFieldDef {
  name: string;
  /** Tracker field type: string, text, number, select, multiselect, relationship, ... */
  type: string;
  itemType?: string;
  multiValue?: boolean;
}

export type WikiTypeStorage = 'pages' | 'table';

export interface WikiTypeDef {
  typeId: string;
  displayName: string;
  displayNamePlural: string;
  storage: WikiTypeStorage;
  /**
   * True when the YAML declares `storage:` explicitly. Only these types keep
   * their items in the wiki; every other type in `.nimbalyst/trackers` (bugs,
   * tasks, app-database types) is readable here but its items live in the app.
   */
  wikiType: boolean;
  fields: WikiFieldDef[];
  /** Field holding the item title (`roles.title`, default `title`). */
  titleField: string;
  /** Absolute path of the YAML file. */
  sourcePath: string;
}

interface RawType {
  type?: unknown;
  extends?: unknown;
  displayName?: unknown;
  displayNamePlural?: unknown;
  storage?: unknown;
  fields?: unknown;
  roles?: unknown;
}

/**
 * Field names a wiki type may not use. Nimbalyst's tracker model keeps these
 * keys for an item's own metadata (its activity log, comments, timestamps,
 * links), so a field with one of these names saves to the file but never shows
 * in a table or page header. Mirrors `NON_FIELD_KEYS` in @nimbalyst/tracker-core.
 */
export const RESERVED_FIELD_NAMES: readonly string[] = [
  'id', 'type', 'typeTags', 'issueNumber', 'issueKey', 'localKey', 'source', 'sourceRef',
  'archived', 'archivedAt', 'syncStatus', 'content', 'module', 'lineNumber', 'workspace',
  'lastIndexed', 'created', 'updated', 'authorIdentity', 'lastModifiedBy', 'createdByAgent',
  'linkedSessions', 'linkedCommitSha', 'linkedCommits', 'linkedPullRequests', 'linkedIssues',
  'documentId', 'activity', 'comments', 'origin', 'triagedAt', 'triagedBy', 'derivedSignals',
  'assigneeId', 'reporterId', 'customFields',
];
const RESERVED_FIELDS = new Set(RESERVED_FIELD_NAMES);

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function readFields(raw: unknown): WikiFieldDef[] {
  if (!Array.isArray(raw)) return [];
  const out: WikiFieldDef[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const name = str(e.name);
    if (!name) continue;
    out.push({
      name,
      type: str(e.type) ?? 'string',
      ...(str(e.itemType) ? { itemType: str(e.itemType)! } : {}),
      ...(e.multiValue === true ? { multiValue: true } : {}),
    });
  }
  return out;
}

/**
 * Loads every `*.yaml` type definition in `typesDir`. Patch files
 * (`*.patch.yaml`) and backups are skipped. `extends` is resolved one level:
 * the parent's fields, then the child's, a child field replacing a parent field
 * of the same name.
 */
export async function loadTypeDefs(
  typesDir: string | null | undefined,
): Promise<{ types: Map<string, WikiTypeDef>; issues: WikiIssue[]; /** Changes whenever any type file's text does. */ signature: string }> {
  const types = new Map<string, WikiTypeDef>();
  const issues: WikiIssue[] = [];
  const texts: string[] = [];
  if (!typesDir) return { types, issues, signature: '' };
  let names: string[];
  try {
    names = await readdir(typesDir);
  } catch {
    return { types, issues, signature: '' };
  }
  const raws = new Map<string, { raw: RawType; sourcePath: string }>();
  for (const name of names.sort()) {
    if (!name.endsWith('.yaml') || name.includes('.patch.')) continue;
    const sourcePath = path.join(typesDir, name);
    try {
      const text = await readFile(sourcePath, 'utf8');
      texts.push(`${name}\0${text}`);
      const raw = yaml.load(text, { schema: yaml.CORE_SCHEMA }) as RawType;
      const typeId = raw && typeof raw === 'object' ? str(raw.type) : null;
      if (!typeId) continue;
      raws.set(typeId, { raw, sourcePath });
    } catch (err) {
      issues.push({ code: 'malformed-type', path: sourcePath, message: (err as Error).message.split('\n')[0] });
    }
  }
  for (const [typeId, { raw, sourcePath }] of raws) {
    const parentId = str(raw.extends);
    const parent = parentId ? raws.get(parentId)?.raw : undefined;
    const fields = new Map<string, WikiFieldDef>();
    for (const field of readFields(parent?.fields)) fields.set(field.name, field);
    for (const field of readFields(raw.fields)) fields.set(field.name, field);
    const displayName = str(raw.displayName) ?? str(parent?.displayName) ?? typeId;
    const roles = (raw.roles && typeof raw.roles === 'object' ? raw.roles : parent?.roles) as Record<string, unknown> | undefined;
    const wikiType = str(raw.storage) === 'table' || str(raw.storage) === 'pages';
    for (const name of fields.keys()) {
      if (wikiType && RESERVED_FIELDS.has(name)) {
        issues.push({
          code: 'reserved-field',
          path: sourcePath,
          message: `Field "${name}" of type ${typeId} uses a name Nimbalyst keeps for an item's own metadata, so its values are saved but never shown; rename the field`,
        });
      }
    }
    types.set(typeId, {
      typeId,
      displayName,
      displayNamePlural: str(raw.displayNamePlural) ?? `${displayName}s`,
      storage: str(raw.storage) === 'table' ? 'table' : 'pages',
      wikiType,
      fields: [...fields.values()],
      titleField: str(roles?.title) ?? 'title',
      sourcePath,
    });
  }
  return { types, issues, signature: contentVersion(texts.join('\0')) };
}
