// The sandbox shell lives in collab-protocol so `nim wiki serve` and the
// collab server can serve it; this path stays for runtime consumers.
export { HTML_EMBED_SHELL_CSP, HTML_EMBED_SHELL_HTML, HTML_EMBED_IFRAME_SANDBOX } from '@nimbalyst/collab-protocol';
