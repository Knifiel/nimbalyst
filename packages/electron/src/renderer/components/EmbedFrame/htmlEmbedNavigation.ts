/**
 * Where a link clicked inside an HTML embed goes on desktop. The embed's
 * bridge has already refused anything but web, `nimbalyst:` and relative
 * hrefs (`classifyEmbedHref`); this routes the rest through the same openers
 * a link in the page itself uses:
 *
 *   - a tracker reference (`nimbalyst://NIM-123` or a console item link)
 *     opens the item;
 *   - any other console link opens that page, document or type in the app;
 *   - another web link opens in the system browser;
 *   - a relative path opens what it names beside the HTML page itself: a
 *     workspace file for an HTML file on disk, a page in the same tree for a
 *     Team or Personal HTML page (never a file on this machine). A Local wiki
 *     HTML file opens a wiki page through the wiki host, because the wiki can
 *     sit in the main checkout outside the active worktree, where the
 *     workspace file opener refuses it; a link naming no page opens as a file.
 */

import { store } from '@nimbalyst/runtime/store';
import type { HtmlEmbedNavigateOptions } from '@nimbalyst/runtime/ui/htmlEmbed/HtmlEmbedFrame';
import { trackerItemByReferenceKeyAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
import { trackerReferenceKeyFromHref } from '@nimbalyst/runtime/plugins/TrackerLinkPlugin/trackerReferenceHref';
import { navigateToTrackerReference } from '@nimbalyst/runtime/plugins/TrackerLinkPlugin/trackerReferenceData';
import { openWorkspaceFileLink } from '@nimbalyst/runtime/editor/utils/workspaceLinkNavigation';
import { isHtmlPagePath } from '@nimbalyst/runtime/ui/htmlEmbed/htmlPageCodec';
import { isCollabUri, parseCollabUri } from '@nimbalyst/collab-protocol';

import { openConsoleLinkInWindow } from '../../utils/openConsoleLink';
import { openSharedDocumentInTab } from '../../utils/openSharedDocumentInTab';
import {
  getPersonalCollabDocsSession,
  getPersonalCollabHost,
  sharedDocumentsAtom,
  sharedFoldersAtom,
} from '../../store/atoms/collabDocuments';
import { resolveSharedPageLink } from './sharedPageLinks';

const PERSONAL_PAGE_PREFIX = 'personal-doc://';

/** What a relative link in an HTML page resolves against: the page itself. */
export type HtmlLinkBase =
  | { kind: 'file'; path: string | null }
  | { kind: 'team'; documentId: string }
  | { kind: 'personal'; documentId: string; workspacePath: string }
  | { kind: 'wiki-file'; documentId: string; workspacePath: string; path: string };

/** The link base for an HTML page from its editor path (a file, `collab://`, or `personal-doc://`). */
export function htmlLinkBaseFor(path: string | null | undefined, workspacePath: string | null): HtmlLinkBase {
  if (path && isCollabUri(path)) return { kind: 'team', documentId: parseCollabUri(path).documentId };
  if (path?.startsWith(PERSONAL_PAGE_PREFIX) && workspacePath) {
    return { kind: 'personal', documentId: path.slice(PERSONAL_PAGE_PREFIX.length), workspacePath };
  }
  const wikiPageId = path && workspacePath
    ? getPersonalCollabHost(workspacePath).source().documentIdForFile(path)
    : null;
  if (path && workspacePath && wikiPageId) return { kind: 'wiki-file', documentId: wikiPageId, workspacePath, path };
  return { kind: 'file', path: path ?? null };
}

function openRelativePageLink(href: string, newTab: boolean, base: Exclude<HtmlLinkBase, { kind: 'file' }>): void {
  if (base.kind === 'team') {
    const documentId = resolveSharedPageLink(href, base.documentId, store.get(sharedDocumentsAtom), store.get(sharedFoldersAtom));
    if (documentId) openSharedDocumentInTab(documentId, 'embedded_document', { newTab });
    else console.warn('[HtmlEmbed] no team page for link', href);
    return;
  }
  const session = getPersonalCollabDocsSession(base.workspacePath);
  const documentId = resolveSharedPageLink(href, base.documentId, store.get(session.atoms.sharedDocuments), store.get(session.atoms.sharedFolders));
  if (!documentId && base.kind === 'wiki-file') {
    openFileLink(href, base.path);
    return;
  }
  if (!documentId) {
    console.warn('[HtmlEmbed] no personal page for link', href);
    return;
  }
  const host = getPersonalCollabHost(base.workspacePath);
  void host.resolveScope().then((scope) =>
    host.openArtifact({ kind: 'document', scope, documentId, teamProjectId: null }, 'embedded_document', { newTab }));
}

/**
 * A link to an `.html` file from a document on disk. In a shared document a
 * relative link names a shared page, which `EmbedFrame` resolves.
 */
export function isWorkspaceHtmlEmbed(src: string, documentPath: string | null | undefined): boolean {
  if (documentPath && isCollabUri(documentPath)) return false;
  if (/^[a-z][a-z0-9+.-]+:/i.test(src) && !/^file:/i.test(src)) return false;
  return isHtmlPagePath(src.split(/[?#]/)[0]);
}

function openFileLink(href: string, path: string | null): void {
  if (!openWorkspaceFileLink(href, path)) {
    console.warn('[HtmlEmbed] no opener for relative link', href);
  }
}

export function openHtmlEmbedLink(
  href: string,
  { newTab, kind }: HtmlEmbedNavigateOptions,
  base: HtmlLinkBase,
): void {
  if (kind === 'relative') {
    if (base.kind !== 'file') {
      openRelativePageLink(href, newTab, base);
      return;
    }
    openFileLink(href, base.path);
    return;
  }

  const referenceKey = trackerReferenceKeyFromHref(href);
  if (referenceKey) {
    const item = store.get(trackerItemByReferenceKeyAtom(referenceKey));
    if (item) {
      navigateToTrackerReference({ id: item.id }, { fromPage: true, newTab });
      return;
    }
  }

  if (kind === 'web') {
    if (openConsoleLinkInWindow(href, { newTab })) return;
    void window.electronAPI?.openExternal?.(href);
    return;
  }

  console.warn('[HtmlEmbed] no tracker item for link', href);
}
