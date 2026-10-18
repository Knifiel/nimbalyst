/**
 * Host side of the HTML embed: an iframe on the sandbox shell plus the bridge
 * that renders into it and listens to it.
 *
 * The frame is `sandbox="allow-scripts allow-popups"` and never
 * `allow-same-origin`, so the author's HTML runs with an opaque origin. A
 * message is trusted only when it comes from this iframe's own window and
 * parses as a shell message; a navigate href reaches `onNavigate` only when
 * `classifyEmbedHref` accepts it.
 *
 * New `html` reloads the shell rather than re-rendering in place: a second
 * `document.write` would run the author's top-level `let`/`const` again in
 * the same window and throw. Theme changes are applied live.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';

import {
  classifyEmbedHref,
  createHtmlEmbedHostMessage,
  readHtmlEmbedMessage,
  type EmbedHrefKind,
  type HtmlEmbedTheme,
} from './htmlEmbedProtocol';
import { HTML_EMBED_IFRAME_SANDBOX } from './htmlEmbedShell';
import { htmlEmbedThemeKey } from './htmlEmbedTheme';

export const HTML_EMBED_DEFAULT_HEIGHT = 240;

export interface HtmlEmbedNavigateOptions {
  newTab: boolean;
  kind: EmbedHrefKind;
}

export interface HtmlEmbedFrameProps {
  html: string;
  /** URL of the shell document, served with `HTML_EMBED_SHELL_CSP`. */
  shellUrl: string;
  onNavigate: (href: string, options: HtmlEmbedNavigateOptions) => void;
  theme: HtmlEmbedTheme;
  /** Fixed height in px; otherwise the frame follows its content's height. */
  height?: number;
  className?: string;
  title?: string;
}

export function HtmlEmbedFrame({
  html,
  shellUrl,
  onNavigate,
  theme,
  height,
  className,
  title = 'Embedded HTML',
}: HtmlEmbedFrameProps): React.ReactElement {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const htmlRef = useRef(html);
  const themeRef = useRef(theme);
  const onNavigateRef = useRef(onNavigate);
  const renderedRef = useRef(false);
  const [generation, setGeneration] = useState(0);
  const [contentHeight, setContentHeight] = useState<number | null>(null);

  themeRef.current = theme;
  onNavigateRef.current = onNavigate;

  useEffect(() => {
    if (htmlRef.current === html) return;
    htmlRef.current = html;
    renderedRef.current = false;
    setGeneration((value) => value + 1);
  }, [html]);

  const post = useCallback((message: Parameters<typeof createHtmlEmbedHostMessage>[0]) => {
    iframeRef.current?.contentWindow?.postMessage(createHtmlEmbedHostMessage(message), '*');
  }, []);

  const renderOnce = useCallback(() => {
    if (renderedRef.current || !iframeRef.current?.contentWindow) return;
    renderedRef.current = true;
    post({ type: 'render', html: htmlRef.current, theme: themeRef.current });
  }, [post]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frameWindow = iframeRef.current?.contentWindow;
      if (!frameWindow || event.source !== frameWindow) return;
      const message = readHtmlEmbedMessage(event.data);
      if (!message) return;
      if (message.type === 'ready') {
        renderOnce();
      } else if (message.type === 'resize') {
        setContentHeight(message.height);
      } else {
        const classified = classifyEmbedHref(message.href);
        if (classified) onNavigateRef.current(classified.href, { newTab: message.newTab, kind: classified.kind });
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [renderOnce]);

  const themeKey = htmlEmbedThemeKey(theme);
  const sentThemeKeyRef = useRef(themeKey);
  useEffect(() => {
    if (sentThemeKeyRef.current === themeKey) return;
    sentThemeKeyRef.current = themeKey;
    if (renderedRef.current) post({ type: 'theme', theme: themeRef.current });
  }, [themeKey, post]);

  const frameHeight = height ?? contentHeight ?? HTML_EMBED_DEFAULT_HEIGHT;

  return (
    <iframe
      key={generation}
      ref={iframeRef}
      className={['html-embed-frame', className].filter(Boolean).join(' ')}
      src={shellUrl}
      title={title}
      sandbox={HTML_EMBED_IFRAME_SANDBOX}
      referrerPolicy="no-referrer"
      // The shell posts `ready` before load; this covers a host whose
      // listener attached late.
      onLoad={renderOnce}
      style={{ display: 'block', width: '100%', height: frameHeight, border: 0, background: 'transparent' }}
    />
  );
}
