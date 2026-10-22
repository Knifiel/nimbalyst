// @vitest-environment node
/**
 * The browser app over a static export's files: routes are the export's page
 * folders, file links point into `_wiki/files/`, search runs in the page, and
 * every write is refused.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const files: Record<string, unknown> = {
  'manifest.json': {
    format: 1,
    generatedAt: '2026-10-20T00:00:00Z',
    title: 'Acme wiki',
    nimVersion: '9.9.9',
    homeId: 'home',
    pages: { home: '', acme: 'competitors/acme', row1: 'items/row1' },
    types: { competitor: 'types/competitor' },
  },
  'snapshot.json': {
    pages: [
      { id: 'home', title: 'Home', type: null, path: 'Home.md', dir: 'Home', parentId: null },
      { id: 'acme', title: 'Acme', type: 'competitor', path: 'Competitors/Acme.md', dir: 'Competitors/Acme', parentId: null },
    ],
  },
  'search.json': [
    { id: 'home', title: 'Home', kind: 'page', type: null, path: 'Home.md', body: 'Welcome to the wiki.', fields: {} },
    { id: 'acme', title: 'Acme', kind: 'page', type: 'competitor', path: 'Competitors/Acme.md', body: 'Acme sells widgets.', fields: {} },
  ],
};

beforeAll(() => {
  vi.stubGlobal('window', { __NIMBALYST_WIKI_STATIC__: { format: 1, dataPath: '/_wiki/' } });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const name = url.replace('/_wiki/', '');
    return name in files ? new Response(JSON.stringify(files[name])) : new Response('missing', { status: 404 });
  }));
});
afterAll(() => vi.unstubAllGlobals());

describe('static site', () => {
  it('maps folders to routes and back, reads data files, and refuses writes', async () => {
    // Imported after the stub: the client picks static mode when the module loads.
    const site = await import('../staticSite');
    const { wikiApi } = await import('../client');
    await site.loadStaticSite();

    expect(site.parseStaticLocation('/', '')).toEqual({ kind: 'home' });
    expect(site.parseStaticLocation('/competitors/acme/', '')).toEqual({ kind: 'item', id: 'acme' });
    // A table row is not in the page list, so it opens as an item.
    expect(site.parseStaticLocation('/items/row1/', '')).toEqual({ kind: 'item', id: 'row1' });
    expect(site.parseStaticLocation('/types/competitor/', '')).toEqual({ kind: 'type', typeId: 'competitor' });
    expect(site.parseStaticLocation('/search/', '?q=widgets')).toEqual({ kind: 'search', query: 'widgets' });
    expect(site.parseStaticLocation('/nope/', '')).toEqual({ kind: 'page', id: site.MISSING_PAGE_ID });
    expect(site.staticRoutePath({ kind: 'item', id: 'acme' })).toBe('/competitors/acme/');
    expect(site.staticRoutePath({ kind: 'page', id: 'home' })).toBe('/');

    // An image beside Acme's file, linked as `.assets/logo%20one.png`.
    expect(wikiApi.pageFileUrl('acme', '.assets/logo%20one.png')).toBe('/_wiki/files/Competitors/.assets/logo%20one.png');
    expect((await wikiApi.search('widgets')).map((hit) => hit.id)).toEqual(['acme']);
    // A page with no body file reads as empty, as a bare folder does on the server.
    expect((await wikiApi.readBody('home')).markdown).toBe('');
    await expect(wikiApi.writeBody('home', 'changed', null)).rejects.toMatchObject({ code: 'read-only' });
    await expect(wikiApi.command({ type: 'refresh' })).rejects.toMatchObject({ code: 'read-only' });
  });
});
