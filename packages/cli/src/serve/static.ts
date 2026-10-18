/** Serves the built `@nimbalyst/wiki-web` files, with `index.html` for every app route. */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { ServerResponse } from 'node:http';
import { HTML_EMBED_SHELL_CSP, HTML_EMBED_SHELL_HTML } from '@nimbalyst/collab-protocol';
import { BASE_HEADERS } from './http.js';

/** Where the browser app frames the HTML embed sandbox shell. */
export const HTML_EMBED_SHELL_PATH = '/html-embed/shell';

/**
 * The HTML embed sandbox shell. Its CSP keeps whatever HTML a page embeds in
 * an opaque origin, so it cannot read this server's session cookie or call
 * its API, and blocks fetch/XHR/WebSocket.
 */
export function serveHtmlEmbedShell(res: ServerResponse): void {
  res.writeHead(200, {
    ...BASE_HEADERS,
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': HTML_EMBED_SHELL_CSP,
  });
  res.end(HTML_EMBED_SHELL_HTML);
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
};

export function contentTypeFor(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Streams a file from the wiki itself. Its content is the user's, not the
 * app's, so it never runs as this origin: an SVG or HTML file opened directly
 * gets a sandboxed, script-free document.
 */
export function streamWikiFile(res: ServerResponse, abs: string): void {
  res.writeHead(200, {
    ...BASE_HEADERS,
    'Content-Type': contentTypeFor(abs),
    'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; media-src 'self'",
  });
  createReadStream(abs).pipe(res);
}

/** Inside `root`, or null for a path that tries to leave it. */
function resolveInside(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const abs = path.resolve(root, '.' + path.posix.normalize('/' + decoded));
  return abs === root || abs.startsWith(root + path.sep) ? abs : null;
}

async function isFile(abs: string): Promise<boolean> {
  try {
    return (await stat(abs)).isFile();
  } catch {
    return false;
  }
}

function stream(res: ServerResponse, abs: string, immutable: boolean): void {
  res.writeHead(200, {
    ...BASE_HEADERS,
    'Content-Type': contentTypeFor(abs),
    // Vite puts a content hash in every asset name, so those can be cached; index.html cannot.
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-store',
  });
  createReadStream(abs).pipe(res);
}

export async function serveStatic(res: ServerResponse, assetsDir: string, urlPath: string): Promise<void> {
  const root = path.resolve(assetsDir);
  const abs = resolveInside(root, urlPath);
  if (abs && abs !== root && (await isFile(abs))) {
    stream(res, abs, urlPath.startsWith('/assets/'));
    return;
  }
  // A missing hashed asset is a real 404, not an app route.
  if (urlPath.startsWith('/assets/') || path.extname(urlPath)) {
    res.writeHead(404, { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  stream(res, path.join(root, 'index.html'), false);
}
