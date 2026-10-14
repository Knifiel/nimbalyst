/**
 * What `nim wiki serve` remembers between runs, per wiki: the token and the
 * port. A browser tab holds both (its address and its cookie), so a restart
 * that kept only one would still leave open tabs talking to nothing. The file
 * sits in the CLI's config folder, readable only by the owner, never in the
 * wiki (which may be committed).
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveConfigDir } from '../cloud/config.js';
import { newToken } from './auth.js';
import { startWikiServer, type WikiServer, type WikiServerOptions } from './server.js';

interface Remembered {
  token: string;
  port: number;
}

export interface SessionStore {
  /** This wiki's own file. One file per wiki, so two servers never rewrite each other's. */
  file: string;
  /** The wiki's absolute root, recorded in the file for a person reading it. */
  root?: string;
}

export function defaultSessionStore(wikiRoot: string, configDir = resolveConfigDir()): SessionStore {
  const key = createHash('sha256').update(path.resolve(wikiRoot)).digest('hex').slice(0, 24);
  return { file: path.join(configDir, 'wiki-serve', `${key}.json`), root: wikiRoot };
}

function recall(store: SessionStore): Partial<Remembered> {
  try {
    const parsed = JSON.parse(fs.readFileSync(store.file, 'utf8')) as Partial<Remembered>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // Missing or unreadable: nothing remembered; this start writes a fresh file.
    return {};
  }
}

function remember(store: SessionStore, session: Remembered): void {
  const dir = path.dirname(store.file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32' && (fs.statSync(dir).mode & 0o777) !== 0o700) fs.chmodSync(dir, 0o700);
  const tmp = `${store.file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...(store.root ? { root: store.root } : {}), ...session }, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, store.file);
}

/**
 * Starts the server with the wiki's remembered token, on its remembered port
 * unless `options.port` names one. When the remembered port is taken, any free
 * port is used and remembered instead.
 */
export async function startRememberedWikiServer(options: WikiServerOptions, store: SessionStore): Promise<WikiServer> {
  const saved = recall(store);
  const token = options.token ?? (typeof saved?.token === 'string' && saved.token.length >= 16 ? saved.token : newToken());
  let server: WikiServer;
  if (options.port || !saved?.port) {
    server = await startWikiServer({ ...options, token });
  } else {
    try {
      server = await startWikiServer({ ...options, token, port: saved.port });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
      server = await startWikiServer({ ...options, token, port: 0 });
    }
  }
  try {
    remember(store, { token, port: server.port });
  } catch {
    // Not remembered: this run still works; the next one gets a new link.
  }
  return server;
}
