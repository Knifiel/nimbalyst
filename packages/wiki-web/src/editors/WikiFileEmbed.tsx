/**
 * An embedded editor page inside a markdown page
 * (`[Diagram](Plan/Diagram.excalidraw "width=800 height=600")`): the linked
 * page in its own editor over its own file host, as a canvas card shows it.
 *
 * It renders inside the markdown editor's React root, not the app's, so the
 * app's draft store is passed in and provided again here: an embed's unsaved
 * edits then hold navigation like any other open editor.
 */
import type { ReactNode } from 'react';
import type { FileEmbedRequest } from '@nimbalyst/collab-bundle/editor';
import type { LocalPage } from '@nimbalyst/local-wiki';
import { DraftStoreContext, type DraftStore } from '../app/drafts';
import { ExtensionPageEditor } from './ExtensionPageEditor';
import { editorForFile } from './wikiEditors';
import { WikiHtmlEmbed } from './html/WikiHtmlEmbed';

const DEFAULT_HEIGHT = 480;

/** `width`/`height` title attributes as CSS lengths; a bare number is pixels. */
export function embedSize(attrs: Readonly<Record<string, string>>): { width: string; height: string } {
  const length = (value: string | undefined, fallback: string) => {
    if (!value) return fallback;
    return /^\d+(\.\d+)?$/.test(value) ? `${value}px` : /^\d+(\.\d+)?(px|%|em|rem|vh)$/.test(value) ? value : fallback;
  };
  return { width: length(attrs.width, '100%'), height: length(attrs.height, `${DEFAULT_HEIGHT}px`) };
}

export function renderWikiFileEmbed(embed: FileEmbedRequest, page: LocalPage | null, drafts: DraftStore): ReactNode | null {
  if (!page?.path || page.documentType === 'markdown') return null;
  // An HTML page is live and interactive in place: no editor chrome, no selection first.
  if (page.documentType === 'html') {
    const height = /^\d+$/.test(embed.attrs.height ?? '') ? Number(embed.attrs.height) : undefined;
    return (
      <div className="wiki-web-html-embed max-w-full" style={{ width: embedSize(embed.attrs).width }} data-page-id={page.id}>
        <WikiHtmlEmbed pageId={page.id} title={embed.label || page.title} height={height} />
      </div>
    );
  }
  const fileName = `${page.title}${page.fileExtension}`;
  const editor = editorForFile(fileName);
  if (!editor) return null;
  const { width, height } = embedSize(embed.attrs);
  return (
    <DraftStoreContext.Provider value={drafts}>
      <div className="wiki-web-file-embed flex min-w-0 max-w-full flex-col overflow-hidden rounded border border-nim" style={{ width, height }} data-page-id={page.id}>
        <ExtensionPageEditor key={page.id} pageId={page.id} fileName={fileName} filePath={page.path} editor={editor} embedded />
      </div>
    </DraftStoreContext.Provider>
  );
}
