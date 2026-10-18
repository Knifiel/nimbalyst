/**
 * Wire contract between a host page and the HTML embed sandbox shell. Lives
 * here so every host (desktop, web console, `nim wiki serve`) shares it; the
 * React side is `@nimbalyst/runtime/ui/htmlEmbed`.
 *
 * Every message is an envelope `{ channel, v, type, ... }` sent with
 * `postMessage(msg, '*')`: the shell runs with an opaque origin, so neither
 * side can name the other's origin. The host trusts a message only when
 * `event.source` is its own iframe's window and the envelope parses here.
 * The author's scripts share that window with the shell, so they can post
 * anything the shell can; every field is validated as if it were hostile.
 */

export const HTML_EMBED_CHANNEL = 'nimbalyst-html-embed';
export const HTML_EMBED_PROTOCOL_VERSION = 1;

/** A frame cannot grow the host page past this, whatever it reports. */
export const HTML_EMBED_MAX_HEIGHT = 8000;

export interface HtmlEmbedTheme {
  colorScheme: 'light' | 'dark';
  /** `--nim-*` custom properties, applied on the content's :root. */
  vars: Record<string, string>;
}

/** Host to shell. */
export type HtmlEmbedHostMessage =
  | { type: 'render'; html: string; theme: HtmlEmbedTheme }
  | { type: 'theme'; theme: HtmlEmbedTheme };

/** Shell to host, after validation. */
export type HtmlEmbedShellMessage =
  | { type: 'ready' }
  | { type: 'resize'; height: number }
  | { type: 'navigate'; href: string; newTab: boolean };

export interface HtmlEmbedEnvelope {
  channel: typeof HTML_EMBED_CHANNEL;
  v: typeof HTML_EMBED_PROTOCOL_VERSION;
}

export function createHtmlEmbedHostMessage(message: HtmlEmbedHostMessage): HtmlEmbedEnvelope & HtmlEmbedHostMessage {
  return { channel: HTML_EMBED_CHANNEL, v: HTML_EMBED_PROTOCOL_VERSION, ...message };
}

export function clampEmbedHeight(height: number): number {
  return Math.min(HTML_EMBED_MAX_HEIGHT, Math.max(0, Math.ceil(height)));
}

/** Parses a shell-to-host message, or null when it is not one. */
export function readHtmlEmbedMessage(data: unknown): HtmlEmbedShellMessage | null {
  if (!data || typeof data !== 'object') return null;
  const message = data as Record<string, unknown>;
  if (message.channel !== HTML_EMBED_CHANNEL || message.v !== HTML_EMBED_PROTOCOL_VERSION) return null;
  switch (message.type) {
    case 'ready':
      return { type: 'ready' };
    case 'resize':
      if (typeof message.height !== 'number' || !Number.isFinite(message.height)) return null;
      return { type: 'resize', height: clampEmbedHeight(message.height) };
    case 'navigate':
      if (typeof message.href !== 'string') return null;
      return { type: 'navigate', href: message.href, newTab: Boolean(message.newTab) };
    default:
      return null;
  }
}

export type EmbedHrefKind = 'web' | 'nimbalyst' | 'relative';

export interface ClassifiedEmbedHref {
  kind: EmbedHrefKind;
  href: string;
}

const SCHEME_PATTERN = /^([a-z][a-z0-9+.-]*):/i;

/**
 * Decides whether an href a frame asked the host to open is safe to hand to
 * the host's link openers. Only http(s), `nimbalyst:` and relative paths pass.
 *
 * Normalizes the way the URL parser does before looking at the scheme, so
 * `java\tscript:` and a leading control character cannot pass as relative.
 * Scheme-relative and backslash-led hrefs are refused: a URL parser resolves
 * them to another host, and they are not workspace paths.
 */
export function classifyEmbedHref(rawHref: unknown): ClassifiedEmbedHref | null {
  if (typeof rawHref !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const href = rawHref.replace(/[\t\n\r]/g, '').replace(/^[\u0000- ]+|[\u0000- ]+$/g, '');
  if (!href || href.startsWith('#')) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(href)) return null;

  const scheme = SCHEME_PATTERN.exec(href)?.[1]?.toLowerCase();
  if (scheme) {
    if (scheme === 'http' || scheme === 'https') return { kind: 'web', href };
    if (scheme === 'nimbalyst') return { kind: 'nimbalyst', href };
    return null;
  }
  if (/^[/\\]{2}/.test(href)) return null;
  // A colon before the first slash would make the URL parser read a scheme
  // this pattern did not (it requires a leading letter); refuse it.
  const firstSlash = href.search(/[/?#]/);
  const head = firstSlash === -1 ? href : href.slice(0, firstSlash);
  if (head.includes(':')) return null;
  return { kind: 'relative', href };
}
