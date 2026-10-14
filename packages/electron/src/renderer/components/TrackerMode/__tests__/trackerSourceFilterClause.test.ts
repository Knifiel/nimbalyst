// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  SOURCE_FILTER_FIELD,
  sourceFilterField,
  splitSourceClause,
  withSourceClause,
} from '../trackerSourceFilterClause';

const SOURCES = ['native', 'github-issues', 'linear'];
const STATUS = { field: 'status', op: '=' as const, value: 'open' };

describe('trackerSourceFilterClause', () => {
  it('round-trips the source list through the box as one clause after the column filters', () => {
    for (const sourceFilter of [[], ['github-issues'], ['github-issues', 'linear']]) {
      const merged = withSourceClause({ combinator: 'and', clauses: [STATUS] }, sourceFilter);
      expect(merged!.clauses[0]).toEqual(STATUS);
      expect(splitSourceClause(merged!, SOURCES)).toEqual({
        columnFilters: { combinator: 'and', clauses: [STATUS] },
        sourceFilter,
      });
    }
  });

  it('reads typed and negated source clauses as the sources they select', () => {
    const split = (clause: object) => splitSourceClause({ combinator: 'and', clauses: [{ field: SOURCE_FILTER_FIELD, ...clause } as never] }, SOURCES).sourceFilter;
    expect(split({ op: 'contains', value: 'git' })).toEqual(['github-issues']);
    expect(split({ op: '!=', value: 'native' })).toEqual(['github-issues', 'linear']);
    expect(split({ op: 'is-empty' })).toEqual([]);
  });

  it('counts items per source and labels known providers', () => {
    const field = sourceFilterField(['native', 'native', 'github-issues']);
    expect(field.options).toEqual([
      { value: 'native', label: 'Native', count: 2 },
      { value: 'github-issues', label: 'GitHub', count: 1 },
    ]);
  });
});
