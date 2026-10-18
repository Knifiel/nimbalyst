// The wire contract lives in collab-protocol so `nim wiki serve` and the
// collab server can share it; this path stays for runtime consumers.
export {
  HTML_EMBED_CHANNEL,
  HTML_EMBED_PROTOCOL_VERSION,
  HTML_EMBED_MAX_HEIGHT,
  createHtmlEmbedHostMessage,
  clampEmbedHeight,
  readHtmlEmbedMessage,
  classifyEmbedHref,
} from '@nimbalyst/collab-protocol';
export type {
  HtmlEmbedTheme,
  HtmlEmbedHostMessage,
  HtmlEmbedShellMessage,
  HtmlEmbedEnvelope,
  EmbedHrefKind,
  ClassifiedEmbedHref,
} from '@nimbalyst/collab-protocol';
