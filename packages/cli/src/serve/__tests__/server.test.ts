// @vitest-environment node
/**
 * `nim wiki serve` over a real temp wiki: the token gate, a REST round trip,
 * the stale-write conflict, and a change event after an outside edit.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { initWiki, openWiki, type LocalWiki } from '@nimbalyst/local-wiki';
import { HTML_EMBED_SHELL_CSP, HTML_EMBED_SHELL_HTML } from '@nimbalyst/collab-protocol';
import { startWikiServer, type WikiServer } from '../server.js';
import { defaultSessionStore, startRememberedWikiServer } from '../session.js';
import { createServer } from 'node:net';
import { parseArgs } from '../../cli/parse.js';
import { wantsOpen } from '../runWikiServe.js';
import { initLocalWiki } from '../../localWiki/open.js';
import { serveTool } from '../../mcp/serveTool.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function serve(): Promise<{ root: string; wiki: LocalWiki; server: WikiServer }> {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'nim-serve-')));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const assets = path.join(root, '.assets');
  mkdirSync(assets);
  writeFileSync(path.join(assets, 'index.html'), '<!doctype html><title>wiki</title>');
  await initWiki(path.join(root, 'wiki'));
  const wiki = await openWiki(path.join(root, 'wiki'), { debounceMs: 20 });
  cleanups.push(() => wiki.close());
  const server = await startWikiServer({ wiki, assetsDir: assets, version: 'test' });
  cleanups.push(() => server.close());
  return { root, wiki, server };
}

/** `fetch` will not send a custom Host header; plain http will. */
function rawStatus(port: number, headers: Record<string, string>, path = '/api/snapshot'): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('nim wiki serve', () => {
  it('opens the browser for a person at a terminal, not for scripts or over SSH', () => {
    const args = (...flags: string[]) => parseArgs(['wiki', 'serve', ...flags]);
    expect(wantsOpen(args(), {}, true)).toBe(true);
    expect(wantsOpen(args('--no-open'), {}, true)).toBe(false);
    expect(wantsOpen(args(), {}, false)).toBe(false);
    expect(wantsOpen(args(), { SSH_CONNECTION: '1.2.3.4 1 5.6.7.8 22' }, true)).toBe(false);
    expect(wantsOpen(args('--open'), { SSH_CONNECTION: 'x' }, false)).toBe(true);
    // A boolean flag never swallows the next argument.
    expect(parseArgs(['wiki', 'serve', '--no-open', '--port', '0']).flags.port).toBe('0');
  });

  it('refuses requests without the token and trades the URL token for a cookie', async () => {
    const { server } = await serve();
    expect((await fetch(`${server.origin}/api/snapshot`)).status).toBe(401);
    expect((await fetch(`${server.origin}/`)).status).toBe(401);
    expect((await fetch(`${server.origin}/api/snapshot`, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);

    const first = await fetch(server.url, { redirect: 'manual' });
    expect(first.status).toBe(302);
    expect(first.headers.get('location')).toBe('/');
    const cookie = first.headers.get('set-cookie')!.split(';')[0];
    expect(cookie).toBe(`nim_wiki_${server.port}=${server.token}`);

    const page = await fetch(`${server.origin}/some/app/route`, { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<title>wiki</title>');

    // A page on another site cannot ride the cookie, and a rebinding Host is refused.
    expect((await fetch(`${server.origin}/api/snapshot`, { headers: { cookie, origin: 'https://evil.example' } })).status).toBe(403);
    expect(await rawStatus(server.port, { cookie, host: `evil.example:${server.port}` })).toBe(421);
  });

  // Release-blocking: HTML a page embeds runs in this shell, never as the app's origin.
  it('serves the HTML embed shell with its sandbox CSP, and the sandboxed frame cannot call the API', async () => {
    const { server } = await serve();
    const cookie = `nim_wiki_${server.port}=${server.token}`;
    const shell = await fetch(`${server.origin}/html-embed/shell`, { headers: { cookie } });
    expect(shell.status).toBe(200);
    expect(shell.headers.get('content-security-policy')).toBe(HTML_EMBED_SHELL_CSP);
    expect(shell.headers.get('content-security-policy')).toMatch(/^sandbox allow-scripts allow-popups;/);
    expect(await shell.text()).toBe(HTML_EMBED_SHELL_HTML);
    // A sandboxed frame's requests carry `Origin: null`.
    expect((await fetch(`${server.origin}/api/snapshot`, { headers: { cookie, origin: 'null' } })).status).toBe(403);
  });

  // Some embedded browser panels withhold the SameSite=Strict cookie from the frame.
  it('serves the HTML embed shell without the token, since it holds no wiki data', async () => {
    const { server } = await serve();
    const shell = await fetch(`${server.origin}/html-embed/shell`);
    expect(shell.status).toBe(200);
    expect(await shell.text()).toBe(HTML_EMBED_SHELL_HTML);
    // The page bodies the shell renders still need the token.
    expect((await fetch(`${server.origin}/api/snapshot`)).status).toBe(401);
    expect(await rawStatus(server.port, { host: `evil.example:${server.port}` }, '/html-embed/shell')).toBe(421);
  });

  it('creates, reads and writes a page through REST, and rejects a stale write with 409', async () => {
    const { root, server } = await serve();
    const auth = { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' };
    const call = async (method: string, route: string, body?: unknown) => {
      const res = await fetch(`${server.origin}${route}`, { method, headers: auth, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, json: (await res.json()) as Record<string, any> };
    };

    const created = await call('POST', '/api/command', { type: 'register-document', title: 'Acme', parentFolderId: null, body: 'Hello\n' });
    expect(created.status).toBe(200);
    const id = created.json.id as string;
    const snapshot = await call('GET', '/api/snapshot');
    expect(snapshot.json.items.map((d: { title: string }) => d.title)).toEqual(['Acme']);

    const read = await call('GET', `/api/pages/${id}/body`);
    expect(read.json.markdown).toBe('Hello\n');
    const written = await call('PUT', `/api/pages/${id}/body`, { markdown: 'Edited\n', expectedVersion: read.json.version });
    expect(written.status).toBe(200);
    expect(readFileSync(path.join(root, 'wiki', 'Acme.md'), 'utf8')).toMatch(/^---\nid: .*---\nEdited\n$/s);

    // A write based on the old version loses and gets the current text back.
    const stale = await call('PUT', `/api/pages/${id}/body`, { markdown: 'Lost\n', expectedVersion: read.json.version });
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ ok: false, reason: 'conflict', currentVersion: written.json.version, markdown: 'Edited\n' });
    expect(readFileSync(path.join(root, 'wiki', 'Acme.md'), 'utf8')).not.toContain('Lost');

    expect((await call('GET', '/api/search?q=edited')).json.hits[0]).toMatchObject({ id, title: 'Acme' });
    expect((await call('GET', '/api/pages/nope/body')).status).toBe(404);
  });

  it('stores an uploaded attachment beside the page and serves the files a page links to', async () => {
    const { root, server } = await serve();
    const bearer = { Authorization: `Bearer ${server.token}` };
    const created = await fetch(`${server.origin}/api/command`, {
      method: 'POST',
      headers: { ...bearer, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'register-document', title: 'Q3 Plan', parentFolderId: null, body: '' }),
    });
    const id = ((await created.json()) as { id: string }).id;
    const upload = (name: string, bytes: Uint8Array, type = 'application/octet-stream') =>
      fetch(`${server.origin}/api/pages/${id}/attachments?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { ...bearer, 'Content-Type': type }, body: bytes });

    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const stored = await upload('shot one.png', png);
    expect(stored.status).toBe(200);
    expect(await stored.json()).toEqual({ path: 'Q3 Plan/.assets/shot one.png', link: 'Q3%20Plan/.assets/shot%20one.png' });
    expect(readFileSync(path.join(root, 'wiki', 'Q3 Plan/.assets/shot one.png'))).toEqual(Buffer.from(png));

    // A cross-site form can only send simple content types; those never reach the wiki.
    expect((await upload('x.txt', png, 'text/plain')).status).toBe(415);
    expect((await upload('big.bin', new Uint8Array(25 * 1024 * 1024 + 1))).status).toBe(413);

    const file = (link: string) => fetch(`${server.origin}/api/pages/${id}/file?path=${encodeURIComponent(link)}`, { headers: bearer });
    const served = await file('Q3 Plan/.assets/shot one.png');
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(served.headers.get('content-security-policy')).toContain('sandbox');
    expect(Buffer.from(await served.arrayBuffer())).toEqual(Buffer.from(png));
    expect((await file('../../secret')).status).toBe(404);
    expect((await file('.nimbalyst-wiki.yaml')).status).toBe(404);
  });

  it('streams a change event when a page file is edited outside the server', async () => {
    const { root, server } = await serve();
    const res = await fetch(`${server.origin}/api/events`, { headers: { Authorization: `Bearer ${server.token}` } });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    const nextEvent = async (name: string) => {
      for (;;) {
        const frames = buffer.split('\n\n');
        buffer = frames.pop()!;
        const hit = frames.find((frame) => frame.includes(`event: ${name}\n`));
        if (hit) return JSON.parse(hit.slice(hit.indexOf('data: ') + 6));
        const { value, done } = await reader.read();
        if (done) throw new Error('stream ended');
        buffer += value;
      }
    };
    await nextEvent('ready');

    writeFileSync(path.join(root, 'wiki', 'Outside.md'), '---\nid: 01J9Z3K6V4C2W8N5QX7R1T0BHM\n---\nWritten by an editor\n');
    const change = await nextEvent('change');
    expect(change.changedIds).toContain('01J9Z3K6V4C2W8N5QX7R1T0BHM');
    await reader.cancel();
  });

  it('keeps the port and token across a restart, so open tabs keep working', async () => {
    const { root, wiki } = await serve();
    const sessions = path.join(root, 'serve-sessions.json');
    const start = (port?: number) => startRememberedWikiServer({ wiki, assetsDir: null, version: 'test', port }, { file: sessions });
    const first = await start();
    await first.close();
    const second = await start();
    cleanups.push(() => second.close());
    expect([second.port, second.token]).toEqual([first.port, first.token]);
    expect((await fetch(`${second.origin}/api/info`, { headers: { cookie: `nim_wiki_${first.port}=${first.token}` } })).status).toBe(200);
    expect((statSync(sessions).mode & 0o777).toString(8)).toBe('600');

    // The remembered port is taken: another free port, the same token.
    await second.close();
    const blocker = createServer().listen(first.port, '127.0.0.1');
    await new Promise((resolve) => blocker.once('listening', resolve));
    cleanups.push(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
    const third = await start();
    cleanups.push(() => third.close());
    expect(third.port).not.toBe(first.port);
    expect(third.token).toBe(first.token);
  });

  it('remembers each wiki in its own owner-only file, so two servers never overwrite each other', async () => {
    const config = realpathSync(mkdtempSync(path.join(tmpdir(), 'nim-serve-config-')));
    cleanups.push(() => rmSync(config, { recursive: true, force: true }));
    const [a, b] = [defaultSessionStore('/work/a/wiki', config), defaultSessionStore('/work/b/wiki', config)];
    expect(a.file).not.toBe(b.file);
    expect(defaultSessionStore('/work/a/wiki', config).file).toBe(a.file);
    const { wiki } = await serve();
    const first = await startRememberedWikiServer({ wiki, assetsDir: null, version: 'test' }, a);
    await first.close();
    expect((statSync(path.dirname(a.file)).mode & 0o777).toString(8)).toBe('700');
    expect(JSON.parse(readFileSync(a.file, 'utf8'))).toEqual({ root: '/work/a/wiki', token: first.token, port: first.port });
  });

  it('converts a table type to pages over REST', async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'nim-serve-convert-')));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(path.join(root, 'types'));
    writeFileSync(path.join(root, 'types', 'partner.yaml'), 'type: partner\ndisplayNamePlural: Partners\nstorage: table\nfields:\n  - name: activity\n    type: string\n');
    await initWiki(path.join(root, 'wiki'));
    writeFileSync(path.join(root, 'wiki', 'Partners.csv'), 'id,title\nP1,Globex\n');
    const wiki = await openWiki(path.join(root, 'wiki'), { typesDir: path.join(root, 'types') });
    cleanups.push(() => wiki.close());
    const server = await startWikiServer({ wiki, assetsDir: null, version: 'test' });
    cleanups.push(() => server.close());
    const post = (route: string, body: unknown) =>
      fetch(`${server.origin}${route}`, { method: 'POST', headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    const types = await (await fetch(`${server.origin}/api/types`, { headers: { Authorization: `Bearer ${server.token}` } })).json();
    expect(types.types[0].problems).toEqual([expect.stringContaining('"activity"')]);
    expect((await post('/api/types/partner/convert', { storage: 'table' })).status).toBe(400);
    const res = await post('/api/types/partner/convert', { storage: 'pages' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ converted: ['P1'] });
    expect((await wiki.trackerSnapshot('partner')).items.map((item) => [item.id, item.storage])).toEqual([['P1', 'pages']]);
  });

  it('streams a types event when a type definition changes', async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'nim-serve-types-')));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    await initWiki(path.join(root, 'wiki'));
    const typesDir = path.join(root, 'types');
    const wiki = await openWiki(path.join(root, 'wiki'), { debounceMs: 20, typesDir, typesPollMs: 20 });
    cleanups.push(() => wiki.close());
    const server = await startWikiServer({ wiki, assetsDir: null, version: 'test' });
    cleanups.push(() => server.close());
    const res = await fetch(`${server.origin}/api/events`, { headers: { Authorization: `Bearer ${server.token}` } });
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      if (buffer.includes('event: types\n')) break;
      if (buffer.includes('event: ready\n') && !existsSync(typesDir)) {
        // The types folder appears after the server started, as during setup.
        mkdirSync(typesDir);
        writeFileSync(path.join(typesDir, 'partner.yaml'), 'type: partner\nstorage: table\n');
      }
      const { value, done } = await reader.read();
      if (done) throw new Error('stream ended');
      buffer += value;
    }
    await reader.cancel();
  });

  it('openWikiInBrowser starts one server for the session, reuses it, and stops it on close', async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'nim-serve-tool-')));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    process.env.NIM_CONFIG_DIR = path.join(root, 'config');
    cleanups.push(() => void delete process.env.NIM_CONFIG_DIR);
    const assets = path.join(root, 'web');
    mkdirSync(assets);
    writeFileSync(path.join(assets, 'index.html'), '<!doctype html><title>wiki</title>');
    const opened: string[] = [];
    const tool = serveTool({ startDir: root, assetsDir: assets, version: 'test', openUrl: (url) => opened.push(url) });
    cleanups.push(() => tool.close());

    const missing = await tool.call({});
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain('initLocalWiki');

    (await initLocalWiki(root)).wiki.close();
    const first = JSON.parse((await tool.call({})).content[0].text) as { url: string };
    const second = JSON.parse((await tool.call({ open: false })).content[0].text) as { url: string };
    expect(second.url).toBe(first.url);
    expect(opened).toEqual([first.url]);
    expect((await fetch(first.url, { redirect: 'manual' })).status).toBe(302);

    await tool.close();
    await expect(fetch(first.url)).rejects.toThrow();
  });
});
