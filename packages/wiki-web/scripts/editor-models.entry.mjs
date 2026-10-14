/**
 * The editors' pure document code, bundled for Node as
 * `dist/models/editor-models.mjs`: what `nim mcp` uses to edit mind map and
 * drawing pages as files, without mounting an editor. The specifiers are
 * aliased to the extensions' own source by `scripts/build.mjs`, so the tools
 * and the editors read and write the same format.
 *
 * Bump EDITOR_MODELS_VERSION when an export's shape changes; nim checks it.
 */
export { applyMindmapOperations, createEmptyDocument, parseDocument, serializeDocument } from '@nimbalyst/mindmap-model';
export { createArrow, createFrame, createLabeledRectangle, createRectangle, createText } from '@nimbalyst/excalidraw-elements';
export { LayoutEngine } from '@nimbalyst/excalidraw-layout';

export const EDITOR_MODELS_VERSION = 1;
