// @vitest-environment jsdom
/**
 * The view keeps its whole state in one host-held query string, and the
 * omnibox commits a filter as two updates in one tick (filters, then the
 * leftover search text). Both must survive.
 */
import React, { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PagesSearchView } from '../PagesSearchView';

vi.mock('../../useTrackerData', () => ({
  useTrackerDataSelector: (selector: (state: { records: unknown[]; loaded: boolean }) => unknown) => selector({ records: [], loaded: true }),
}));

const PAGES = [
  { documentId: 'doc-a', title: 'Alpha page', updatedAt: 2, fields: { tags: ['alpha'] } },
  { documentId: 'doc-b', title: 'Beta page', updatedAt: 1, fields: { tags: ['beta'] } },
];

function Host() {
  const [search, setSearch] = useState('');
  return (
    <PagesSearchView
      lane="team"
      pages={PAGES}
      typePlacements={[]}
      authorLabel={(author) => author}
      search={search}
      onSearchChange={(next) => setSearch(next)}
      onOpenPage={() => {}}
      onOpenItem={() => {}}
    />
  );
}

afterEach(cleanup);

describe('PagesSearchView', () => {
  it('keeps a committed tag filter as a pill in the box and narrows the rows to it', () => {
    render(<Host />);
    const input = screen.getByTestId('tracker-filter-omnibox-input');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'tags:alpha' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(screen.queryByText('Beta page')).toBeNull();
    screen.getByText('Alpha page');
    // The pill sits inside the search box, before the text.
    expect(screen.getByTestId('tracker-filter-omnibox-pill-0').closest('.tracker-filter-omnibox-box')).not.toBeNull();
  });
});
