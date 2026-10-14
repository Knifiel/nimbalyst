/**
 * The extension editors the browser view builds in: every editor page type the
 * local wiki stores, by slug in `@nimbalyst/web-editors/pinned`. Project
 * canvas is not a pin; it ships in the collab bundle.
 */
export const WIKI_EDITOR_SLUGS = ['excalidraw', 'mindmap', 'csv-spreadsheet', 'calc-sheets', 'datamodellm', 'mockuplm'];

/** Where `build.mjs` puts each editor's production build; Vite reads it from here. */
export function wikiEditorBuildDir(packageRoot, slug) {
  return `${packageRoot}/node_modules/.cache/wiki-web-editors/${slug}`;
}
