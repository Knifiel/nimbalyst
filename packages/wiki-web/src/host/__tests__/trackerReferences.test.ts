// @vitest-environment node
/**
 * References in a page body resolve against the wiki's own typed pages, and
 * `#` can offer them: the resolver the app builds over LocalTrackerDataSource.
 */
import { describe, expect, it, vi } from 'vitest';
import type { WikiTypeInfo } from '../../api/client';

const persona: WikiTypeInfo = { typeId: 'persona', displayName: 'Persona', displayNamePlural: 'Personas', storage: 'pages', fields: [], titleField: 'title', definition: null };

vi.mock('../../api/client', () => ({
  wikiApi: {
    types: async () => [persona],
    trackerSnapshot: async (typeId: string) => ({
      typeId,
      storage: 'pages',
      version: null,
      items: [{ id: 'cmo', type: 'persona', title: 'Chief marketing officer', fields: {}, storage: 'pages', path: 'Personas/CMO.md', parentId: null, parentKind: null, order: null, createdAt: 1, updatedAt: 1 }],
    }),
  },
  wikiChanges: { subscribe: () => () => {} },
}));

const { createTrackerReferenceResolver } = await import('@nimbalyst/collab-bundle/trackers-ui');
const { LocalTrackerDataSource } = await import('../LocalTrackerDataSource');

describe('tracker references in the browser view', () => {
  it('resolves a reference to a local typed page by id and offers it when searching', async () => {
    const opened: string[] = [];
    const resolver = createTrackerReferenceResolver(new LocalTrackerDataSource('/wiki', [persona]), { onOpenItem: (id) => opened.push(id) });
    const resolved = await vi.waitFor(() => {
      const resolution = resolver.resolve('cmo');
      if (resolution.state !== 'resolved') throw new Error(resolution.state);
      return resolution;
    });
    expect(resolved.item.title).toBe('Chief marketing officer');
    expect(resolver.search!('chief').options.map((option) => option.referenceKey)).toEqual(['cmo']);
    resolver.openItem!('cmo');
    expect(opened).toEqual(['cmo']);
    resolver.dispose();
  });
});
