// @vitest-environment node
/**
 * A link clicked inside an HTML page in the browser view: a relative path
 * opens the wiki page it names relative to the page holding the embed, a
 * tracker key opens the item, and a web link opens in a new tab.
 */
import { describe, expect, it, vi } from 'vitest';
import { openWikiHtmlLink, type WikiHtmlNavigationDeps } from '../html/wikiHtmlNavigation';

function deps(): WikiHtmlNavigationDeps & { [K in keyof WikiHtmlNavigationDeps]: ReturnType<typeof vi.fn> } {
  return {
    resolveLink: vi.fn((_from: string, href: string) => (href === 'Sync.md' ? { kind: 'page' as const, id: 'p-sync' } : { kind: 'outside' as const, path: href })),
    navigate: vi.fn(),
    itemIdForKey: vi.fn((key: string) => (key === 'KB-12' ? 'item-12' : null)),
    openExternal: vi.fn(),
    notice: vi.fn(),
  } as never;
}

describe('openWikiHtmlLink', () => {
  it('opens a relative page link from the embedding page', () => {
    const d = deps();
    openWikiHtmlLink('Sync.md', { newTab: true, kind: 'relative' }, 'p-home', d);
    expect(d.resolveLink).toHaveBeenCalledWith('p-home', 'Sync.md');
    expect(d.navigate).toHaveBeenCalledWith({ kind: 'page', id: 'p-sync' }, { newTab: true });
  });

  it('tells the reader when a relative link is not a page', () => {
    const d = deps();
    openWikiHtmlLink('../src/main.ts', { newTab: false, kind: 'relative' }, 'p-home', d);
    expect(d.navigate).not.toHaveBeenCalled();
    expect(d.notice).toHaveBeenCalled();
  });

  it('opens tracker keys as items and other web links in a new tab', () => {
    const d = deps();
    openWikiHtmlLink('nimbalyst://KB-12', { newTab: false, kind: 'nimbalyst' }, 'p-home', d);
    expect(d.navigate).toHaveBeenCalledWith({ kind: 'item', id: 'item-12' }, { newTab: false });
    openWikiHtmlLink('https://d3js.org', { newTab: false, kind: 'web' }, 'p-home', d);
    expect(d.openExternal).toHaveBeenCalledWith('https://d3js.org');
  });
});
