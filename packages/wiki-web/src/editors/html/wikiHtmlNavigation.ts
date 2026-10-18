/**
 * Where a link clicked inside an HTML page goes in the browser view. The
 * embed's bridge has already refused anything but web, `nimbalyst:` and
 * relative hrefs. A relative path opens the wiki page it names, a tracker key
 * opens the item, and a web link opens in a new browser tab.
 */
import type { HtmlEmbedNavigateOptions } from '@nimbalyst/runtime-source/ui/htmlEmbed/HtmlEmbedFrame';
import { trackerReferenceKeyFromHref } from '@nimbalyst/runtime-source/plugins/TrackerLinkPlugin/trackerReferenceHref';
import type { LinkTarget } from '../../host/links';

export interface WikiHtmlNavigationDeps {
  resolveLink(fromPageId: string, href: string): LinkTarget;
  navigate(route: { kind: 'page' | 'item'; id: string }, options: { newTab: boolean }): void;
  /** Item id for a tracker key, or null when the wiki has no such item. */
  itemIdForKey(key: string): string | null;
  openExternal(href: string): void;
  notice(message: string): void;
}

export function openWikiHtmlLink(
  href: string,
  { newTab, kind }: HtmlEmbedNavigateOptions,
  fromPageId: string | null,
  deps: WikiHtmlNavigationDeps,
): void {
  if (kind === 'relative') {
    if (!fromPageId) return;
    const target = deps.resolveLink(fromPageId, href);
    if (target.kind === 'outside') deps.notice(`${target.path} is not a page in this wiki, so it cannot open here.`);
    else deps.navigate(target, { newTab });
    return;
  }
  const key = trackerReferenceKeyFromHref(href);
  const itemId = key ? deps.itemIdForKey(key) : null;
  if (itemId) {
    deps.navigate({ kind: 'item', id: itemId }, { newTab });
    return;
  }
  if (kind === 'web') deps.openExternal(href);
  else deps.notice(`${href} is not an item in this wiki.`);
}
