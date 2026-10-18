/**
 * Where the desktop serves the HTML embed sandbox shell: a route on the
 * `nim-preview://` protocol (main/protocols/nimPreviewProtocol.ts) that answers
 * with the shell's sandbox CSP. A test keeps the two constants equal.
 */
export const DESKTOP_HTML_EMBED_SHELL_URL = 'nim-preview://html-embed/shell';
