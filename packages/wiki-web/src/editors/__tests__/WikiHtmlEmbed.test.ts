// @vitest-environment jsdom
/**
 * F-R1-2: a relative link in an embedded HTML page resolves beside the HTML
 * page, as when the page is opened on its own, not beside the page that
 * embeds it.
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

const opened = vi.hoisted(() => ({ calls: [] as unknown[][] }));

vi.mock('../../api/client', () => ({
  wikiApi: { readBody: async () => ({ markdown: '<a href="./Module.md">Module</a>', version: 'v1' }) },
  wikiChanges: { subscribe: () => () => {} },
}));
vi.mock('../wikiEditors', () => ({ editorForFile: () => null }));
vi.mock('../../theme', () => ({ currentTheme: () => 'light', onThemeChange: () => () => {} }));
vi.mock('../html/htmlPages', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../html/htmlPages')>()),
  navigateFromHtml: (...args: unknown[]) => opened.calls.push(args),
}));

const { renderWikiFileEmbed } = await import('../WikiFileEmbed');
const { DraftStore } = await import('../../app/drafts');

describe('an embedded HTML page', () => {
  it('navigates from its own page, not the page holding the embed', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const page = { id: 'p-map', title: 'Map', fileExtension: '.html', documentType: 'html', path: 'Maps/Map.html' };
    const node = renderWikiFileEmbed({ src: 'Maps/Map.html', label: 'Map', attrs: {} }, page as never, new DraftStore());
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement('div', null, node));
    });
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
    const iframe = container.querySelector('iframe')!;
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        source: iframe.contentWindow,
        data: { channel: 'nimbalyst-html-embed', v: 1, type: 'navigate', href: './Module.md', newTab: false },
      }));
    });
    expect(opened.calls).toEqual([['p-map', './Module.md', { newTab: false, kind: 'relative' }]]);
    act(() => root.unmount());
  });
});
