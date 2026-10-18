/**
 * Security E2E for the HTML embed sandbox shell, in a real browser.
 *
 * A teammate's HTML runs inside every reader's app, so the shell must keep it
 * in an opaque origin even in the worst case, where the host page and the
 * shell share an origin. A plain http server serves a host page and the shell
 * (with the shell's sandbox CSP) from the same origin; the host frames the
 * shell exactly as `HtmlEmbedFrame` does. The author's HTML then probes
 * everything it must not reach and reports through the bridge.
 *
 * No Electron app is launched; this runs against the browser alone.
 */
import { test, expect } from '@playwright/test';
import * as http from 'http';
import type { AddressInfo } from 'net';
import {
  HTML_EMBED_IFRAME_SANDBOX,
  HTML_EMBED_SHELL_CSP,
  HTML_EMBED_SHELL_HTML,
} from '../../../collab-protocol/src/htmlEmbedShell';
import { HTML_EMBED_CHANNEL } from '../../../collab-protocol/src/htmlEmbedProtocol';

const AUTHOR_HTML = `<!doctype html>
<html><head><style>body { margin: 0; } .box { height: 333px; }</style></head>
<body>
<div class="box"><a id="plain" href="Modules/Sync.md">Sync</a> <a id="blank" href="nimbalyst://NIM-1" target="_blank">NIM-1</a></div>
<script>
  var probes = {};
  function probe(name, read) {
    try { probes[name] = 'reached:' + String(read()).slice(0, 60); } catch (error) { probes[name] = 'blocked'; }
  }
  probe('parentDocument', function () { return parent.document.title; });
  probe('parentElectronAPI', function () { return parent.electronAPI.secret; });
  probe('topLocation', function () { return top.location.href; });
  probe('cookie', function () { return document.cookie; });
  probe('localStorage', function () { return localStorage.getItem('secret'); });
  probe('sessionStorage', function () { return sessionStorage.getItem('secret'); });
  probe('indexedDB', function () { return indexedDB.open('x'); });
  probes.origin = window.origin;
  probes.themeAtParse = getComputedStyle(document.documentElement).getPropertyValue('--nim-bg').trim();
  probes.scheme = getComputedStyle(document.documentElement).colorScheme;
  fetch('/secret').then(function () { return 'reached'; }, function () { return 'blocked'; }).then(function (result) {
    probes.fetch = result;
    window.nimbalyst.navigate('probe:' + JSON.stringify(probes));
  });
</script>
</body></html>`;

const HOST_HTML = `<!doctype html>
<html><head><title>HOST-SECRET-TITLE</title></head><body>
<script>
  window.electronAPI = { secret: 'HOST-SECRET-API' };
  localStorage.setItem('secret', 'HOST-SECRET-STORAGE');
  sessionStorage.setItem('secret', 'HOST-SECRET-STORAGE');
  document.cookie = 'secret=HOST-SECRET-COOKIE';
  window.received = [];
  var frame = document.createElement('iframe');
  frame.setAttribute('sandbox', ${JSON.stringify(HTML_EMBED_IFRAME_SANDBOX)});
  frame.src = '/shell';
  frame.style.width = '600px';
  frame.style.height = '200px';
  document.body.appendChild(frame);
  window.addEventListener('message', function (event) {
    if (event.source !== frame.contentWindow) return;
    var data = event.data;
    if (!data || data.channel !== ${JSON.stringify(HTML_EMBED_CHANNEL)}) return;
    window.received.push(data);
    if (data.type === 'ready') {
      frame.contentWindow.postMessage({
        channel: ${JSON.stringify(HTML_EMBED_CHANNEL)}, v: 1, type: 'render',
        html: window.authorHtml,
        theme: { colorScheme: 'dark', vars: { '--nim-bg': 'rgb(1, 2, 3)', '--nim-evil': '}<\\/style><\\/script>' } }
      }, '*');
    }
  });
</script>
</body></html>`;

let server: http.Server;
let baseUrl: string;

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/shell') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': HTML_EMBED_SHELL_CSP });
      res.end(HTML_EMBED_SHELL_HTML);
    } else if (req.url === '/host') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(HOST_HTML.replace('window.received = [];', `window.received = []; window.authorHtml = ${JSON.stringify(AUTHOR_HTML).replace(/</g, '\\u003c')};`));
    } else {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      res.end('server-secret');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

type Received = { type: string; href?: string; newTab?: boolean; height?: number };

async function received(page: import('@playwright/test').Page): Promise<Received[]> {
  return page.evaluate(() => (window as unknown as { received: Received[] }).received);
}

test('author HTML runs in an opaque origin and reaches nothing of the host', async ({ page }) => {
  await page.goto(`${baseUrl}/host`);
  await expect.poll(async () => (await received(page)).some((m) => m.href?.startsWith('probe:'))).toBe(true);
  const probeMessage = (await received(page)).find((m) => m.href?.startsWith('probe:'))!;
  const probes = JSON.parse(probeMessage.href!.slice('probe:'.length));
  expect(probes).toMatchObject({
    parentDocument: 'blocked',
    parentElectronAPI: 'blocked',
    topLocation: 'blocked',
    cookie: 'blocked',
    localStorage: 'blocked',
    sessionStorage: 'blocked',
    indexedDB: 'blocked',
    origin: 'null',
    fetch: 'blocked',
    // The theme is in place before the author's scripts run, and a value
    // that tries to break out of the style block is dropped.
    themeAtParse: 'rgb(1, 2, 3)',
    scheme: 'dark',
  });
});

test('links and height go through the bridge after the author document replaces the shell', async ({ page }) => {
  await page.goto(`${baseUrl}/host`);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#plain')).toBeVisible();
  await expect.poll(async () => (await received(page)).filter((m) => m.type === 'resize').map((m) => m.height)).toContain(333);
  // The empty shell never reports a height, so the host does not collapse between reloads.
  expect((await received(page)).filter((m) => m.type === 'resize').map((m) => m.height)).toEqual([333]);

  await frame.locator('#plain').click();
  await frame.locator('#plain').click({ modifiers: ['Meta'] });
  await frame.locator('#blank').click();
  await expect.poll(async () => (await received(page)).filter((m) => m.type === 'navigate' && !m.href!.startsWith('probe:'))).toEqual([
    expect.objectContaining({ href: 'Modules/Sync.md', newTab: false }),
    expect.objectContaining({ href: 'Modules/Sync.md', newTab: true }),
    expect.objectContaining({ href: 'nimbalyst://NIM-1', newTab: true }),
  ]);
  // The click did not navigate the frame away from the author document.
  await expect(frame.locator('#plain')).toBeVisible();
});

test('the shell URL opened directly is still sandboxed', async ({ page }) => {
  const response = await page.goto(`${baseUrl}/shell`);
  expect(response!.headers()['content-security-policy']).toBe(HTML_EMBED_SHELL_CSP);
  const result = await page.evaluate(() => {
    let storage = 'reached';
    try {
      localStorage.getItem('x');
    } catch {
      storage = 'blocked';
    }
    return { origin: window.origin, storage };
  });
  expect(result).toEqual({ origin: 'null', storage: 'blocked' });
});
