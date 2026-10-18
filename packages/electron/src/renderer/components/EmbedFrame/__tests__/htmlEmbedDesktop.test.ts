/**
 * Desktop routing for HTML embeds: which links render in the sandbox, and
 * where a link clicked inside one goes. A tracker key opens the item, a
 * console link opens in the app, any other web link goes to the system
 * browser, and a relative path opens relative to the page it sits in.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const opened = vi.hoisted(() => ({
  workspace: vi.fn(() => true),
  console: vi.fn(() => false),
  tracker: vi.fn(),
  shared: vi.fn(() => true),
  personal: vi.fn(),
  items: new Map<string, unknown>(),
  wikiFiles: new Map<string, string>(),
}));

vi.mock('@nimbalyst/runtime/editor/utils/workspaceLinkNavigation', () => ({ openWorkspaceFileLink: opened.workspace }));
vi.mock('../../../utils/openConsoleLink', () => ({ openConsoleLinkInWindow: opened.console }));
vi.mock('@nimbalyst/runtime/plugins/TrackerLinkPlugin/trackerReferenceData', () => ({ navigateToTrackerReference: opened.tracker }));
vi.mock('@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms', () => ({
  trackerItemByReferenceKeyAtom: (key: string) => key,
}));
vi.mock('@nimbalyst/runtime/store', () => ({ store: { get: (key: string) => opened.items.get(key) ?? null } }));
vi.mock('../../../utils/openSharedDocumentInTab', () => ({ openSharedDocumentInTab: opened.shared }));
vi.mock('../../../store/atoms/collabDocuments', () => ({
  sharedDocumentsAtom: 'team-docs',
  sharedFoldersAtom: 'team-folders',
  getPersonalCollabDocsSession: () => ({ atoms: { sharedDocuments: 'personal-docs', sharedFolders: 'personal-folders' } }),
  getPersonalCollabHost: () => ({
    resolveScope: async () => 'personal-scope',
    openArtifact: opened.personal,
    source: () => ({ documentIdForFile: (path: string) => opened.wikiFiles.get(path) ?? null }),
  }),
}));

import { htmlLinkBaseFor, isWorkspaceHtmlEmbed, openHtmlEmbedLink } from '../htmlEmbedNavigation';

const openExternal = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  opened.items.clear();
  (window as unknown as { electronAPI: unknown }).electronAPI = { openExternal };
});

describe('isWorkspaceHtmlEmbed', () => {
  it('takes .html files linked from a document on disk', () => {
    expect(isWorkspaceHtmlEmbed('map.html', '/ws/Home.md')).toBe(true);
    expect(isWorkspaceHtmlEmbed('../maps/Product Map.HTML?x=1', '/ws/docs/Home.md')).toBe(true);
    expect(isWorkspaceHtmlEmbed('C:\\ws\\map.html', 'C:\\ws\\Home.md')).toBe(true);
  });

  it('leaves mockups, web URLs and shared documents to their own renderers', () => {
    expect(isWorkspaceHtmlEmbed('screen.mockup.html', '/ws/Home.md')).toBe(false);
    expect(isWorkspaceHtmlEmbed('https://example.com/map.html', '/ws/Home.md')).toBe(false);
    expect(isWorkspaceHtmlEmbed('map.html', 'collab://org/org-1/doc/doc-1')).toBe(false);
    expect(isWorkspaceHtmlEmbed('map.excalidraw', '/ws/Home.md')).toBe(false);
  });
});

describe('openHtmlEmbedLink', () => {
  it('opens a relative path against the embedding document', () => {
    openHtmlEmbedLink('Modules/Sync.md', { newTab: false, kind: 'relative' }, { kind: 'file', path: '/ws/wiki/Home.md' });
    expect(opened.workspace).toHaveBeenCalledWith('Modules/Sync.md', '/ws/wiki/Home.md');
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('opens a tracker reference as the item', () => {
    opened.items.set('NIM-123', { id: 'item-1' });
    openHtmlEmbedLink('nimbalyst://NIM-123', { newTab: true, kind: 'nimbalyst' }, { kind: 'file', path: '/ws/Home.md' });
    expect(opened.tracker).toHaveBeenCalledWith({ id: 'item-1' }, { fromPage: true, newTab: true });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('opens console links in the app and other web links in the browser', () => {
    opened.console.mockReturnValueOnce(true);
    openHtmlEmbedLink('https://console.nimbalyst.com/org/o/project/p/page/doc/d', { newTab: false, kind: 'web' }, { kind: 'file', path: null });
    expect(openExternal).not.toHaveBeenCalled();

    openHtmlEmbedLink('https://d3js.org', { newTab: false, kind: 'web' }, { kind: 'file', path: null });
    expect(opened.console).toHaveBeenLastCalledWith('https://d3js.org', { newTab: false });
    expect(openExternal).toHaveBeenCalledWith('https://d3js.org');
  });

  it('does not send an unknown nimbalyst: link anywhere', () => {
    openHtmlEmbedLink('nimbalyst://NIM-999', { newTab: false, kind: 'nimbalyst' }, { kind: 'file', path: null });
    expect(opened.tracker).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });
});

// F-R1-1: a link in a shared HTML page names a page in that page tree, never a file on this machine.
describe('relative links in shared HTML pages', () => {
  const doc = (documentId: string, title: string, extra: Record<string, unknown> = {}) =>
    ({ documentId, title, documentType: 'markdown', parentFolderId: null, ...extra });

  it('takes the page tree from a team or personal page path', () => {
    expect(htmlLinkBaseFor('collab://org:org-1:doc:doc-1', '/ws')).toEqual({ kind: 'team', documentId: 'doc-1' });
    expect(htmlLinkBaseFor('personal-doc://p-1', '/ws')).toEqual({ kind: 'personal', documentId: 'p-1', workspacePath: '/ws' });
    expect(htmlLinkBaseFor('/ws/maps/map.html', '/ws')).toEqual({ kind: 'file', path: '/ws/maps/map.html' });
  });

  it('opens the team page beside the HTML page, matching a markdown title without .md', () => {
    opened.items.set('team-docs', [
      doc('map', 'Maps/Map.html', { documentType: 'html' }),
      doc('maps-module', 'Maps/Module'),
      doc('root-module', 'Module'),
    ]);
    opened.items.set('team-folders', []);
    openHtmlEmbedLink('./Module.md', { newTab: true, kind: 'relative' }, { kind: 'team', documentId: 'map' });
    expect(opened.shared).toHaveBeenCalledWith('maps-module', 'embedded_document', { newTab: true });
    expect(opened.workspace).not.toHaveBeenCalled();
  });

  it('never falls back to a workspace file when no page matches', () => {
    opened.items.set('team-docs', [doc('map', 'Map.html', { documentType: 'html' })]);
    opened.items.set('team-folders', []);
    openHtmlEmbedLink('Home.md', { newTab: false, kind: 'relative' }, { kind: 'team', documentId: 'map' });
    expect(opened.shared).not.toHaveBeenCalled();
    expect(opened.workspace).not.toHaveBeenCalled();
  });

  it('opens a personal page from the personal page tree', async () => {
    opened.items.set('personal-docs', [doc('pmap', 'Map.html', { documentType: 'html' }), doc('home', 'Home')]);
    opened.items.set('personal-folders', []);
    openHtmlEmbedLink('Home.md', { newTab: false, kind: 'relative' }, { kind: 'personal', documentId: 'pmap', workspacePath: '/ws' });
    await vi.waitFor(() => expect(opened.personal).toHaveBeenCalled());
    expect(opened.personal.mock.calls[0]![0]).toMatchObject({ kind: 'document', scope: 'personal-scope', documentId: 'home' });
    expect(opened.workspace).not.toHaveBeenCalled();
  });
});

// A Local wiki file can sit outside the active worktree, where the workspace
// file opener refuses it; its links open wiki pages through the wiki host.
describe('relative links in a Local wiki HTML file', () => {
  const wikiMap = '/main/nimbalyst-local/wiki/Map.html';
  const doc = (documentId: string, title: string, extra: Record<string, unknown> = {}) =>
    ({ documentId, title, documentType: 'markdown', parentFolderId: null, ...extra });

  beforeEach(() => {
    opened.wikiFiles.clear();
    opened.wikiFiles.set(wikiMap, 'pmap');
    opened.items.set('personal-docs', [doc('pmap', 'Map.html', { documentType: 'html' }), doc('home', 'Home')]);
    opened.items.set('personal-folders', []);
  });

  it('opens the linked wiki page, not the workspace file', async () => {
    openHtmlEmbedLink('./Home.md', { newTab: false, kind: 'relative' }, htmlLinkBaseFor(wikiMap, '/ws-worktree'));
    await vi.waitFor(() => expect(opened.personal).toHaveBeenCalled());
    expect(opened.personal.mock.calls[0]![0]).toMatchObject({ kind: 'document', documentId: 'home' });
    expect(opened.workspace).not.toHaveBeenCalled();
  });

  it('opens a link that names no wiki page as a file beside the HTML file', () => {
    openHtmlEmbedLink('Map.assets/chart.png', { newTab: false, kind: 'relative' }, htmlLinkBaseFor(wikiMap, '/ws-worktree'));
    expect(opened.workspace).toHaveBeenCalledWith('Map.assets/chart.png', wikiMap);
    expect(opened.personal).not.toHaveBeenCalled();
  });
});
