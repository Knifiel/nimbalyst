/**
 * A Project canvas card in the browser view: the page its file names, in that
 * page's own editor (a markdown page in the page editor, a drawing or mind map
 * in its extension editor), each over its own file host. A card that names a
 * file outside this wiki, or a shared team document, shows its title and why
 * it cannot open here.
 *
 * Cards render in the board's own React root, so the wiki's context (pages,
 * folders) reaches them through the module-level store below, which the app
 * sets once.
 */
import { useSyncExternalStore } from 'react';
import type { CanvasCardRenderProps } from '@nimbalyst/collab-bundle/canvas';
import type { LocalPage } from '@nimbalyst/local-wiki';
import { PageEditor } from '../../app/PageEditor';
import { ExtensionPageEditor } from '../ExtensionPageEditor';
import { editorForFile } from '../wikiEditors';
import { canvasCardPage, type CanvasCardRoots } from './canvasCardPages';

interface WikiCanvasContext extends CanvasCardRoots {
  pages(): Iterable<LocalPage>;
  /** Subscribes to page tree changes; returns an unsubscribe. */
  subscribe(listener: () => void): () => void;
}

let context: WikiCanvasContext | null = null;
let revision = 0;
const listeners = new Set<() => void>();

export function setWikiCanvasContext(next: WikiCanvasContext): () => void {
  context = next;
  revision += 1;
  for (const listener of [...listeners]) listener();
  const unsubscribe = next.subscribe(() => {
    revision += 1;
    for (const listener of [...listeners]) listener();
  });
  return () => {
    unsubscribe();
    if (context === next) context = null;
  };
}

function useWikiCanvasRevision(): number {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, () => revision);
}

function CardNotice({ label, target, reason }: { label: string; target: string; reason: string }) {
  return (
    <div className="wiki-web-canvas-card-notice flex h-full min-w-0 flex-1 flex-col gap-1 p-3 text-xs text-nim-muted" data-testid="wiki-web-canvas-card-notice">
      <div className="truncate text-sm font-medium text-nim">{label || target}</div>
      <div className="truncate">{target}</div>
      <div>{reason}</div>
    </div>
  );
}

export function WikiCanvasCard({ reference, label }: CanvasCardRenderProps) {
  useWikiCanvasRevision();
  if (reference.kind !== 'file') {
    return <CardNotice label={label} target={reference.uri} reason="A shared team document; open the board in Nimbalyst to see it." />;
  }
  const page = context ? canvasCardPage(reference.path, context.pages(), context) : null;
  if (!page || !page.path) {
    return <CardNotice label={label} target={reference.path} reason="Not a page of this wiki." />;
  }
  if (page.documentType === 'markdown') {
    return (
      <div className="wiki-web-canvas-card h-full min-w-0 flex-1 overflow-auto" data-page-id={page.id}>
        <PageEditor key={page.id} pageId={page.id} />
      </div>
    );
  }
  const fileName = `${page.title}${page.fileExtension}`;
  const editor = editorForFile(fileName);
  if (!editor) return <CardNotice label={label} target={reference.path} reason="No editor for this kind of page in the browser." />;
  return (
    <div className="wiki-web-canvas-card flex h-full min-w-0 flex-1 flex-col" data-page-id={page.id}>
      <ExtensionPageEditor key={page.id} pageId={page.id} fileName={fileName} filePath={page.path} editor={editor} embedded />
    </div>
  );
}
