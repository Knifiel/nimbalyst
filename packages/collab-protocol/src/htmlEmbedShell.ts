/**
 * The sandbox shell every host serves for HTML embeds.
 *
 * A host serves `HTML_EMBED_SHELL_HTML` at a URL of its own with the response
 * header `Content-Security-Policy: HTML_EMBED_SHELL_CSP`, and frames it with
 * `sandbox="allow-scripts allow-popups"` (never `allow-same-origin`). The CSP
 * `sandbox` directive keeps the origin opaque even when the shell URL is
 * opened directly, so the author's HTML never runs as the host's origin: no
 * cookies, storage, parent DOM, `electronAPI` or tokens.
 *
 * The shell waits for one `render` message, writes the author's document into
 * itself with `document.write` (scripts run as they would in a page, and
 * DOMContentLoaded and load fire), then reinstalls its bridge, since
 * `document.open` erases every listener on the window and document. The
 * bridge turns `<a href>` clicks into `navigate` messages, reports content
 * height, and applies `theme` messages to :root.
 *
 * Network policy: scripts, styles, fonts, images and media over https are
 * allowed so explainers can load a library from a CDN; fetch, XHR,
 * WebSocket and EventSource are not (`connect-src 'none'`), nor are nested
 * frames, form posts, or `<base>`.
 */

import { HTML_EMBED_CHANNEL, HTML_EMBED_PROTOCOL_VERSION } from './htmlEmbedProtocol.js';

export const HTML_EMBED_SHELL_CSP = [
  'sandbox allow-scripts allow-popups',
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' https:",
  "style-src 'unsafe-inline' https:",
  'img-src data: blob: https:',
  'font-src data: https:',
  'media-src data: blob: https:',
  "connect-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

/** The sandbox attribute every host puts on the iframe. */
export const HTML_EMBED_IFRAME_SANDBOX = 'allow-scripts allow-popups';

// Plain ES5 inside the shell: it runs in whatever engine the host has, and it
// must not contain a closing script tag.
const SHELL_SCRIPT = `
(function () {
  'use strict';
  var CHANNEL = ${JSON.stringify(HTML_EMBED_CHANNEL)};
  var VERSION = ${HTML_EMBED_PROTOCOL_VERSION};
  var host = window.parent;
  var rendered = false;
  var theme = null;
  var lastHeight = -1;
  var observer = null;
  var VAR_NAME = /^--nim-[A-Za-z0-9_-]+$/;
  var UNSAFE_VALUE = /[<>{};\\\\]/;
  var DOCTYPE = /^\\uFEFF?\\s*<!doctype[^>]*>/i;

  function post(type, fields) {
    if (host === window) return;
    var message = { channel: CHANNEL, v: VERSION, type: type };
    if (fields) for (var key in fields) message[key] = fields[key];
    host.postMessage(message, '*');
  }

  function themeVars(next) {
    var out = [];
    var vars = next && next.vars;
    if (!vars || typeof vars !== 'object') return out;
    for (var name in vars) {
      var value = vars[name];
      if (VAR_NAME.test(name) && typeof value === 'string' && !UNSAFE_VALUE.test(value)) out.push([name, value]);
    }
    return out;
  }

  function scheme(next) {
    return next && next.colorScheme === 'dark' ? 'dark' : 'light';
  }

  // Theme as a style block written ahead of the author's markup, so the
  // author's own scripts see the variables while the document parses.
  function themeStyle(next) {
    if (!next) return '';
    var css = 'color-scheme:' + scheme(next) + ';';
    var vars = themeVars(next);
    for (var i = 0; i < vars.length; i++) css += vars[i][0] + ':' + vars[i][1] + ';';
    return '<style data-nimbalyst-theme>:root{' + css + '}</style>';
  }

  function applyTheme(next) {
    if (!next || typeof next !== 'object') return;
    theme = next;
    var root = document.documentElement;
    if (!root) return;
    root.style.colorScheme = scheme(next);
    root.setAttribute('data-color-scheme', scheme(next));
    var vars = themeVars(next);
    for (var i = 0; i < vars.length; i++) root.style.setProperty(vars[i][0], vars[i][1]);
  }

  function measure() {
    var root = document.documentElement;
    var body = document.body;
    var height = root ? root.getBoundingClientRect().height : 0;
    if (body && body.scrollHeight > height) height = body.scrollHeight;
    return Math.ceil(height);
  }

  function reportHeight() {
    var height = measure();
    if (height === lastHeight) return;
    lastHeight = height;
    post('resize', { height: height });
  }

  // The empty shell has no height worth reporting; the host keeps the last
  // content height until the new content reports its own.
  function observeSize() {
    if (!rendered) return;
    if (observer) observer.disconnect();
    observer = null;
    if (typeof ResizeObserver === 'function' && document.documentElement) {
      observer = new ResizeObserver(reportHeight);
      observer.observe(document.documentElement);
      if (document.body) observer.observe(document.body);
    }
    reportHeight();
  }

  function anchorFor(target) {
    var node = target;
    while (node && node.nodeType !== 1) node = node.parentNode;
    return node && node.closest ? node.closest('a') : null;
  }

  function anchorHref(anchor) {
    var href = anchor.getAttribute('href');
    if (href == null) href = anchor.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
    return href == null ? null : String(href).trim();
  }

  function onClick(event) {
    if (event.defaultPrevented) return;
    if (event.type === 'click' && event.button !== 0) return;
    if (event.type === 'auxclick' && event.button !== 1) return;
    var anchor = anchorFor(event.target);
    if (!anchor) return;
    var href = anchorHref(anchor);
    if (!href || href.charAt(0) === '#') return;
    event.preventDefault();
    var target = (anchor.getAttribute('target') || '').toLowerCase();
    var newTab = event.type === 'auxclick' || event.metaKey || event.ctrlKey || target === '_blank';
    post('navigate', { href: href, newTab: !!newTab });
  }

  function onMessage(event) {
    if (event.source !== host) return;
    var data = event.data;
    if (!data || typeof data !== 'object' || data.channel !== CHANNEL || data.v !== VERSION) return;
    if (data.type === 'render' && typeof data.html === 'string') {
      if (data.theme) theme = data.theme;
      render(data.html);
    } else if (data.type === 'theme') {
      applyTheme(data.theme);
    }
  }

  function installBridge() {
    window.addEventListener('message', onMessage);
    window.addEventListener('click', onClick);
    window.addEventListener('auxclick', onClick);
    window.addEventListener('load', observeSize);
    window.addEventListener('DOMContentLoaded', observeSize);
  }

  function render(html) {
    if (rendered) return;
    rendered = true;
    if (observer) observer.disconnect();
    var match = DOCTYPE.exec(html);
    var doctype = match ? match[0] : '<!doctype html>';
    var rest = match ? html.slice(match[0].length) : html;
    document.open();
    document.write(doctype + themeStyle(theme));
    document.write(rest);
    document.close();
    installBridge();
    applyTheme(theme);
    observeSize();
  }

  try {
    Object.defineProperty(window, 'nimbalyst', {
      value: Object.freeze({
        navigate: function (href, options) {
          if (typeof href !== 'string') return;
          post('navigate', { href: href, newTab: !!(options && options.newTab) });
        }
      }),
      writable: false,
      configurable: false
    });
  } catch (error) {}

  installBridge();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { if (!rendered) post('ready'); });
  } else {
    post('ready');
  }
})();
`;

export const HTML_EMBED_SHELL_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HTML embed</title>
</head>
<body>
<script>${SHELL_SCRIPT}</script>
</body>
</html>
`;
