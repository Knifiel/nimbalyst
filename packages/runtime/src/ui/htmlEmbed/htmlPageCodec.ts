/**
 * The collaborative codec for the `html` page type: an interactive HTML page
 * shared as a team or personal page, edited as Monaco source and shown through
 * the HTML embed sandbox.
 *
 * Every host (desktop, web console, local wiki) imports this one object; the
 * documentType, the suffix and the Y.Text field are what a shared document's
 * index row and every Monaco binding agree on. A restated copy would sync
 * against itself and show an empty page to everyone else.
 *
 * `.html` is also in the `code` codec's suffixes and is claimed by the Browser
 * extension's tab editor; hosts prefer this type for `.html` pages.
 */

// The `/collab` entry, not the SDK barrel; see codeCollabCodec.ts.
import { createTextCollabContentAdapter } from '@nimbalyst/extension-sdk/collab';

export const HTML_PAGE_DOCUMENT_TYPE = 'html';
export const HTML_PAGE_FILE_EXTENSION = '.html';
/** The Y.Text field Monaco binds to. */
export const HTML_PAGE_TEXT_FIELD = 'content';

export const HtmlPageCollabContentAdapter = createTextCollabContentAdapter({
  documentType: HTML_PAGE_DOCUMENT_TYPE,
  fileExtensions: [HTML_PAGE_FILE_EXTENSION],
  mimeType: 'text/html',
  textField: HTML_PAGE_TEXT_FIELD,
});

/** Starting content for a new HTML page. */
export const HTML_PAGE_DEFAULT_CONTENT = `<!doctype html>
<html>
<head>
<style>
  body { font-family: system-ui, sans-serif; color: var(--nim-text); background: var(--nim-bg); margin: 16px; }
  a { color: var(--nim-link); }
</style>
</head>
<body>
<h1>Interactive page</h1>
<p>Links open in Nimbalyst: <a href="Home.md">Home</a>.</p>
</body>
</html>
`;

export function isHtmlPagePath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(HTML_PAGE_FILE_EXTENSION) && !lower.endsWith('.mockup.html');
}
