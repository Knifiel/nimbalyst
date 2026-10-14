/**
 * The Source filter (native items vs. items imported from GitHub, Linear, ...)
 * is its own list in tracker state, not a column filter, because it applies
 * before the view's rows are built. In the toolbar search box it reads as one
 * more pill: these helpers fold it into the box's filter set as a synthetic
 * clause and split it back out when the box changes the set.
 */
import type {
  TrackerFieldFilter,
  TrackerFilterSet,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import type { TrackerFilterField } from '@nimbalyst/collab-client/trackers-ui';

export const SOURCE_FILTER_FIELD = 'trackerSource';

/** Human label for a source key without probing the importer (avoids backend start). */
export function sourceKeyLabel(key: string): string {
  if (key === 'native') return 'Native';
  const known: Record<string, string> = {
    'github-issues': 'GitHub',
    linear: 'Linear',
  };
  if (known[key]) return known[key];
  return key
    .split(/[-_]/)
    .map((p) => (p ? p[0].toUpperCase() + p.slice(1) : p))
    .join(' ');
}

/** The Source field the box offers, with a count per source key. */
export function sourceFilterField(sourceKeys: readonly string[]): TrackerFilterField {
  const counts = new Map<string, number>();
  for (const key of sourceKeys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return {
    id: SOURCE_FILTER_FIELD,
    label: 'Source',
    type: 'multiselect',
    multiValue: true,
    options: [...counts.entries()].map(([value, count]) => ({ value, label: sourceKeyLabel(value), count })),
  };
}

/** The column filters plus the source filter as one more clause, for the box to draw. */
export function withSourceClause(
  columnFilters: TrackerFilterSet | null,
  sourceFilter: readonly string[],
): TrackerFilterSet | null {
  if (sourceFilter.length === 0) return columnFilters;
  const clause: TrackerFieldFilter = sourceFilter.length === 1
    ? { field: SOURCE_FILTER_FIELD, op: '=', value: sourceFilter[0] }
    : { field: SOURCE_FILTER_FIELD, op: 'in', value: [...sourceFilter] };
  return {
    combinator: columnFilters?.combinator ?? 'and',
    clauses: [...(columnFilters?.clauses ?? []), clause],
  };
}

/**
 * Split a filter set from the box back into column filters and the source
 * list. A negated source clause keeps every other known source.
 */
export function splitSourceClause(
  filters: TrackerFilterSet,
  sourceOptions: readonly string[],
): { columnFilters: TrackerFilterSet; sourceFilter: string[] } {
  const sourceClauses = filters.clauses.filter((clause) => clause.field === SOURCE_FILTER_FIELD);
  const columnFilters = {
    combinator: filters.combinator,
    clauses: filters.clauses.filter((clause) => clause.field !== SOURCE_FILTER_FIELD),
  };
  const clause = sourceClauses.at(-1);
  if (!clause) return { columnFilters, sourceFilter: [] };
  const values = (Array.isArray(clause.value) ? clause.value : [clause.value])
    .filter((value) => value !== undefined && value !== null && value !== '')
    .map(String);
  const known = new Set(sourceOptions);
  const named = values.filter((value) => known.has(value));
  switch (clause.op) {
    case '=':
    case 'in':
      return { columnFilters, sourceFilter: named };
    case 'contains': {
      // Typed `source:git` matches the source whose key or label holds the text.
      const needle = values[0]?.toLowerCase() ?? '';
      return {
        columnFilters,
        sourceFilter: sourceOptions.filter((key) => key.toLowerCase().includes(needle) || sourceKeyLabel(key).toLowerCase().includes(needle)),
      };
    }
    case '!=':
    case 'not-in':
      return { columnFilters, sourceFilter: sourceOptions.filter((key) => !named.includes(key)) };
    default:
      return { columnFilters, sourceFilter: [] };
  }
}
