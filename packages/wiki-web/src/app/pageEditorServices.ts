/**
 * What every page body editor in this app gets from the host, provided once by
 * the app shell rather than threaded through each view.
 */
import { createContext, type ReactNode } from 'react';
import type { FileEmbedRequest, PageLinkSource, TrackerReferenceResolver } from '@nimbalyst/collab-bundle/editor';

export interface PageEditorServices {
  /** The `@` picker's pages for the page being edited. */
  pageLinks(pageId: string): PageLinkSource;
  /** An editor page embedded in page `pageId`'s body; null leaves the "unavailable" note. */
  fileEmbed(pageId: string, embed: FileEmbedRequest): ReactNode | null;
  /** Live tracker data for references in page bodies; also what makes `#` insertion possible. */
  trackerReferences?: TrackerReferenceResolver;
}

export const PageEditorServicesContext = createContext<PageEditorServices | null>(null);
