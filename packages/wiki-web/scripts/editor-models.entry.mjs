/**
 * The editors' pure document code, bundled for Node as
 * `dist/models/editor-models.mjs`: what `nim mcp` uses to edit mind map and
 * drawing pages as files, without mounting an editor. The specifiers are
 * aliased to the extensions' own source by `scripts/build.mjs`, so the tools
 * and the editors read and write the same format.
 *
 * `editorCodecs` is the editors' collaboration codecs and `DocumentSyncProvider`
 * the desktop's document room client: the wiki move opens each editor page's
 * team document with one and writes it with the other. They are bundled
 * together so the room's Y.Doc and the codecs share one copy of yjs.
 *
 * Bump EDITOR_MODELS_VERSION when an export's shape changes; nim checks it.
 */
export { applyMindmapOperations, createEmptyDocument, parseDocument, serializeDocument } from '@nimbalyst/mindmap-model';
export { createArrow, createFrame, createLabeledRectangle, createRectangle, createText } from '@nimbalyst/excalidraw-elements';
export { LayoutEngine } from '@nimbalyst/excalidraw-layout';

import { createEditorCodecs } from './editorCodecs.ts';
import { ExcalidrawCollabContentAdapter } from '@nimbalyst/excalidraw-extension/collab-adapter';
import { CsvCollabContentAdapter } from '@nimbalyst/extension-csv-spreadsheet/collab-adapter';
import { DataModelCollabContentAdapter } from '@nimbalyst/extension-datamodellm/collab-adapter';
import { MockupHtmlCollabContentAdapter } from '@nimbalyst/mockuplm/collab-adapters';
import { CalcSheetCollabContentAdapter } from '@nimbalyst/extension-calc-sheets/collab-adapter';
import { mindmapCodec } from '@nimbalyst/mindmap-codec';
import { canvasCollabCodec } from '@nimbalyst/canvas-codec';
import { HtmlPageCollabContentAdapter } from '@nimbalyst/html-page-codec';
export { DocumentSyncProvider } from '@nimbalyst/document-sync';

/** The editors' collaboration codecs, for moving editor pages into a team project (`nim wiki move-to-team`). */
export const editorCodecs = createEditorCodecs([
  ExcalidrawCollabContentAdapter,
  CsvCollabContentAdapter,
  DataModelCollabContentAdapter,
  MockupHtmlCollabContentAdapter,
  CalcSheetCollabContentAdapter,
  mindmapCodec,
  canvasCollabCodec,
  HtmlPageCollabContentAdapter,
]);

export const EDITOR_MODELS_VERSION = 2;
