// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { WikiFeedEvent, WikiTypeInfo } from '../../api/client';

vi.mock('@nimbalyst/collab-bundle/trackers-ui', () => ({ TrackerRevisionsUnsupportedError: class extends Error {} }));

const feed: Array<(event: WikiFeedEvent) => void> = [];
const served: { types: WikiTypeInfo[]; gate: Promise<void> | null; itemsGate: Promise<void> | null; onItems: (() => void) | null } = { types: [], gate: null, itemsGate: null, onItems: null };
vi.mock('../../api/client', () => ({
  wikiApi: {
    types: async () => {
      // Answers with the types as they were when the request reached the server.
      const answer = served.types;
      if (served.gate) await served.gate;
      return answer;
    },
    trackerSnapshot: async (typeId: string) => {
      served.onItems?.();
      if (served.itemsGate) await served.itemsGate;
      return { typeId, storage: 'pages', items: [], version: null };
    },
  },
  wikiChanges: {
    subscribe: (listener: (event: WikiFeedEvent) => void) => {
      feed.push(listener);
      return () => feed.splice(feed.indexOf(listener), 1);
    },
  },
}));

const { LocalTrackerDataSource } = await import('../LocalTrackerDataSource');

const type = (typeId: string, storage: 'pages' | 'table'): WikiTypeInfo => ({
  typeId,
  displayName: typeId,
  displayNamePlural: `${typeId}s`,
  storage,
  fields: [],
  titleField: 'title',
  definition: null,
});

describe('LocalTrackerDataSource types', () => {
  it('rereads the types when the server says they changed, without a page reload', async () => {
    served.types = [type('partner', 'table')];
    const applied: Array<[string[], string[]]> = [];
    const source = new LocalTrackerDataSource('/wiki', served.types, async (previous, next) => {
      applied.push([previous.map((t) => t.typeId), next.map((t) => t.typeId)]);
    });
    const seen: string[] = [];
    source.subscribeTypes(() => seen.push(source.typeInfo('partner')?.storage ?? 'gone'));
    source.subscribe(() => {});

    // A conversion, and a type defined after the page loaded.
    served.types = [type('partner', 'pages'), type('competitor', 'pages')];
    for (const listener of feed) listener({ type: 'types' });
    await vi.waitFor(() => expect(seen).toEqual(['pages']));
    expect(applied).toEqual([[['partner'], ['partner', 'competitor']]]);
    expect(source.allTypes().map((t) => t.typeId)).toEqual(['competitor', 'partner']);
    source.dispose();
  });

  it('rereads once more when the types change again during a reread', async () => {
    served.types = [type('partner', 'table')];
    const source = new LocalTrackerDataSource('/wiki', served.types);
    source.subscribe(() => {});
    let open: () => void = () => {};
    served.gate = new Promise((resolve) => (open = resolve));
    for (const listener of feed) listener({ type: 'types' });
    // The server converts the type while the first reread is still in flight.
    served.types = [type('partner', 'pages')];
    for (const listener of feed) listener({ type: 'types' });
    served.gate = null;
    open();
    await vi.waitFor(() => expect(source.typeInfo('partner')?.storage).toBe('pages'));
    source.dispose();
  });

  it('rereads the types when they change while the items are being reread', async () => {
    served.types = [type('partner', 'table')];
    const source = new LocalTrackerDataSource('/wiki', [type('partner', 'table')]);
    source.subscribe(() => {});
    let open: () => void = () => {};
    served.itemsGate = new Promise<void>((resolve) => (open = resolve));
    const requested = new Promise<void>((resolve) => (served.onItems = resolve));
    for (const listener of feed) listener({ type: 'types' });
    await requested;
    // The types reread is done; the items reread is in flight when the server converts the type.
    served.types = [type('partner', 'pages')];
    for (const listener of feed) listener({ type: 'types' });
    served.itemsGate = null;
    served.onItems = null;
    open();
    await vi.waitFor(() => expect(source.typeInfo('partner')?.storage).toBe('pages'));
    source.dispose();
  });
});
