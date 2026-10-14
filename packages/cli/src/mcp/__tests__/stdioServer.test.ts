// @vitest-environment node
/**
 * `nim mcp` as a client sees it: a real process, JSON-RPC lines on stdin, and
 * nothing on stdout but protocol. The entry is bundled with esbuild (as
 * scripts/build.mjs does) so the test needs no prior build.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { initWiki, openWiki } from '@nimbalyst/local-wiki';
import { PAGE_TOOL_NAMES } from '@nimbalyst/collab-protocol';
import { handleMessage, runStdioServer } from '../stdioServer.js';
import { TeamScopeRefusal, ToolMap, textResult } from '../toolMap.js';
import { resolvePluginWorkspace } from '../pluginWorkspace.js';
import { detectPluginInstall, startUpdateCheck, type PluginInstall } from '../updateCheck.js';

const EDITOR_TOOLS = ['mindmap_get_document', 'mindmap_apply_operations', 'excalidraw_get_elements', 'excalidraw_add_elements', 'excalidraw_add_arrows', 'excalidraw_remove_elements'];
const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const repoRoot = path.resolve(packageDir, '../..');
let outDir = '';
let entry = '';

beforeAll(async () => {
  outDir = mkdtempSync(path.join(tmpdir(), 'nim-mcp-'));
  entry = path.join(outDir, 'cli.mjs');
  await build({
    absWorkingDir: packageDir,
    entryPoints: ['src/bin/cli.ts'],
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['better-sqlite3'],
    define: { __NIM_VERSION__: JSON.stringify('0.0.0-test') },
    alias: {
      '@nimbalyst/tracker-core': path.join(repoRoot, 'packages/tracker-core/src/index.ts'),
      '@nimbalyst/local-wiki': path.join(repoRoot, 'packages/local-wiki/src/index.ts'),
      '@nimbalyst/collab-protocol': path.join(repoRoot, 'packages/collab-protocol/src/index.ts'),
    },
    logLevel: 'silent',
  });
});

afterAll(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

function runNimMcp(lines: unknown[], workspace: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, 'mcp', '--workspace', workspace], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code }));
    for (const line of lines) child.stdin.write(`${typeof line === 'string' ? line : JSON.stringify(line)}\n`);
    child.stdin.end();
  });
}

const call = (id: number, name: string, args: Record<string, unknown>) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: args },
});

const LOCAL_TOOLS = [
  'listPages', 'searchPages', 'readCollabDoc', 'applyCollabDocEdit', 'createSharedDoc', 'createSharedFolder',
  'moveSharedItem', 'renameSharedItem', 'deleteSharedItem', 'setPageType', 'setPageFields',
  'tracker_list_types', 'tracker_list', 'tracker_get', 'tracker_create', 'tracker_update',
];

describe('nim mcp over stdio', () => {
  it('answers initialize and tools/list, ignores notifications, and exits when stdin closes', async () => {
    const empty = realpathSync(mkdtempSync(path.join(tmpdir(), 'nim-mcp-empty-')));
    const { stdout, stderr, code } = await runNimMcp([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'ping' },
      'not json',
      { jsonrpc: '2.0', id: 4, method: 'resources/list' },
      call(5, 'listPages', {}),
      call(6, 'initLocalWiki', {}),
      call(7, 'listPages', {}),
    ], empty);
    const created = existsSync(path.join(empty, 'nimbalyst-local', 'wiki', 'Home.md'));
    rmSync(empty, { recursive: true, force: true });

    expect(code).toBe(0);
    // Every stdout line is a JSON-RPC response: logging went to stderr.
    const responses = stdout.trim().split('\n').map((line) => JSON.parse(line));
    expect(responses).toEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'nimbalyst-local', version: expect.any(String) },
        },
      },
      { jsonrpc: '2.0', id: 2, result: { tools: expect.any(Array) } },
      { jsonrpc: '2.0', id: 3, result: {} },
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
      { jsonrpc: '2.0', id: 4, error: { code: -32601, message: 'Method not found: resources/list' } },
      { jsonrpc: '2.0', id: 5, result: { content: [{ type: 'text', text: expect.stringContaining('Call `initLocalWiki`') }], isError: true } },
      { jsonrpc: '2.0', id: 6, result: { content: [{ type: 'text', text: expect.stringContaining('"created":true') }] } },
      { jsonrpc: '2.0', id: 7, result: { content: [{ type: 'text', text: expect.stringContaining('"title":"Home"') }] } },
    ]);
    // The agent made the wiki itself; no `nim wiki init` step for the user.
    expect(created).toBe(true);
    // The list is stable without a wiki, and every name but the local-only ones is a contract name.
    const names = responses[1].result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(['initLocalWiki', ...LOCAL_TOOLS, 'convertTypeStorage', ...EDITOR_TOOLS, 'openWikiInBrowser', 'teamSignIn', 'moveLocalWikiToTeam', 'openUrl']);
    expect(LOCAL_TOOLS.every((n: string) => (PAGE_TOOL_NAMES as readonly string[]).includes(n))).toBe(true);
    expect(stderr).toContain('nim mcp');
  });

  it('edits pages and typed pages in a local wiki, and refuses team scope', async () => {
    const project = realpathSync(mkdtempSync(path.join(tmpdir(), 'nim-mcp-wiki-')));
    try {
      const dir = path.join(project, 'nimbalyst-local', 'wiki');
      mkdirSync(path.join(project, '.nimbalyst', 'trackers'), { recursive: true });
      writeFileSync(
        path.join(project, '.nimbalyst', 'trackers', 'competitor.yaml'),
        'type: competitor\ndisplayName: Competitor\nstorage: pages\nfields:\n  - name: title\n    type: string\n  - name: status\n    type: select\n  - name: activity\n    type: select\n',
      );
      writeFileSync(path.join(project, '.nimbalyst', 'trackers', 'partner.yaml'), 'type: partner\ndisplayNamePlural: Partners\nstorage: table # one CSV\nfields:\n  - name: tier\n    type: select\n');
      await initWiki(dir);
      const wiki = await openWiki(dir);
      const home = (await wiki.command({ type: 'register-document', title: 'Home', parentFolderId: null, body: 'Welcome.\n' })).id!;
      // A type without `storage:` keeps its items in the app database; an existing page of it stays editable.
      writeFileSync(path.join(project, '.nimbalyst', 'trackers', 'github-pr.yaml'), 'type: github-pr\ndisplayName: Pull request\n');
      const pr = (await wiki.command({ type: 'register-document', title: 'PR 1', parentFolderId: null, pageType: 'github-pr' })).id!;
      writeFileSync(path.join(dir, 'Partners.csv'), 'id,title,tier\nP1,Globex,gold\n');
      wiki.close();

      const { stdout, code } = await runNimMcp([
        call(1, 'createSharedDoc', { title: 'Flags', parentFolderId: home, initialContent: 'We store flags in YAML.\n' }),
        call(2, 'applyCollabDocEdit', { filePath: 'Home/Flags.md', replacements: [{ oldText: 'YAML', newText: 'JSON' }] }),
        call(3, 'searchPages', { query: 'json' }),
        call(4, 'tracker_create', { type: 'competitor', title: 'Acme', status: 'active', description: 'A rival.\n' }),
        call(5, 'tracker_list', { type: 'competitor' }),
        call(6, 'listPages', { section: 'team' }),
        call(7, 'tracker_get', { id: 'NIM-12' }),
        call(8, 'tracker_create', { type: 'bug', title: 'Nope' }),
        call(9, 'tracker_create', { type: 'github-pr', title: 'PR 2' }),
        call(10, 'tracker_update', { id: pr, status: 'merged' }),
        call(11, 'createSharedDoc', { title: 'Flow', documentType: 'excalidraw', initialContent: '{"elements":[]}' }),
        call(12, 'applyCollabDocEdit', { filePath: 'Flow.excalidraw', replacements: [{ oldText: '[]', newText: '[1]' }] }),
        call(13, 'readCollabDoc', { filePath: 'Flow' }),
        call(14, 'tracker_list_types', {}),
        call(15, 'convertTypeStorage', { type: 'partner', storage: 'pages' }),
        call(16, 'tracker_get', { id: 'P1' }),
      ], project);
      expect(code).toBe(0);
      const results = stdout.trim().split('\n').map((line) => JSON.parse(line).result);
      const body = (i: number) => JSON.parse(results[i].content[0].text);

      expect(body(0)).toMatchObject({ path: 'Home/Flags.md', uri: expect.stringMatching(/^local-wiki:\/\//) });
      expect(readFileSync(path.join(dir, 'Home', 'Flags.md'), 'utf8')).toContain('We store flags in JSON.');
      expect(body(2).results.map((r: { title: string }) => r.title)).toEqual(['Flags']);
      expect(readFileSync(path.join(dir, 'Acme.md'), 'utf8')).toMatch(/type: competitor[\s\S]*status: active[\s\S]*A rival\./);
      expect(body(4).items.map((i: { title: string; status: string }) => [i.title, i.status])).toEqual([['Acme', 'active']]);
      for (const i of [5, 6]) {
        expect(results[i].isError).toBe(true);
        expect(results[i].content[0].text).toContain('on the `nimbalyst-team` server');
      }
      expect(results[7].isError).toBe(true);
      expect(results[7].content[0].text).toContain('"bug" is not a wiki type');
      expect(results[8].isError).toBe(true);
      expect(results[8].content[0].text).toContain('"github-pr" items live in the Nimbalyst app database');
      expect(results[8].content[0].text).toContain('storage: pages');
      expect(body(9)).toMatchObject({ id: pr, type: 'github-pr', status: 'merged' });
      // A drawing is its own file; its body is the raw file text.
      expect(body(10)).toMatchObject({ path: 'Flow.excalidraw' });
      expect(body(12)).toMatchObject({ documentType: 'excalidraw', markdown: '{"elements":[1]}' });
      expect(readFileSync(path.join(dir, 'Flow.excalidraw'), 'utf8')).toBe('{"elements":[1]}');
      // A field name the record model keeps for itself is called out where an agent checks its types.
      expect(body(13).types.find((t: { type: string }) => t.type === 'competitor').problems).toEqual([expect.stringContaining('"activity"')]);
      expect(body(14)).toMatchObject({ type: 'partner', storage: 'pages', converted: ['P1'] });
      expect(body(15)).toMatchObject({ id: 'P1', title: 'Globex', storage: 'pages', path: 'Globex.md' });
      expect(readFileSync(path.join(project, '.nimbalyst', 'trackers', 'partner.yaml'), 'utf8')).toContain('storage: pages # one CSV');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe('tool calls', () => {
  const info = { name: 'nimbalyst-local', version: 'test' };
  const tools = new ToolMap()
    .register({
      definition: { name: 'echo', description: 'Echo.', inputSchema: { type: 'object', properties: {} } },
      call: async (args) => textResult(args),
    })
    .register({
      definition: { name: 'tracker_update', description: 'Update.', inputSchema: { type: 'object', properties: {} } },
      call: async () => {
        throw new TeamScopeRefusal('tracker_update');
      },
    });

  it('runs a registered tool, refuses team scope by naming the remote tool, and rejects unknown tools', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let written = '';
    output.on('data', (chunk) => (written += chunk));
    const done = runStdioServer({ tools, serverInfo: info, input, output });
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: { a: 1 } } })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tracker_update', arguments: {} } })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nope' } })}\n`);
    input.end();
    await done;

    const [echo, refused, unknown] = written.trim().split('\n').map((line) => JSON.parse(line));
    expect(echo.result).toEqual({ content: [{ type: 'text', text: '{"a":1}' }] });
    expect(refused.result.isError).toBe(true);
    expect(refused.result.content[0].text).toContain('Call `tracker_update` on the `nimbalyst-team` server');
    expect(unknown.error).toEqual({ code: -32602, message: 'Unknown tool: nope' });
  });

  it('rejects a message that is not a request object', async () => {
    expect(await handleMessage([1, 2], tools, info)).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Invalid request' },
    });
  });
});

describe('plugin workspace', () => {
  const pluginRoot = '/home/u/.codex/plugins/cache/nimbalyst/nimbalyst-wiki/0.3.0';

  it('uses Claude Code project, else Codex PWD only when started in the plugin directory', () => {
    expect(resolvePluginWorkspace({ CLAUDE_PROJECT_DIR: '/repo', PWD: '/other' }, pluginRoot, pluginRoot)).toBe('/repo');
    expect(resolvePluginWorkspace({ PWD: '/repo' }, `${pluginRoot}/`, pluginRoot)).toBe('/repo');
    // A host that moved the cwd without updating PWD: the cwd wins.
    expect(resolvePluginWorkspace({ PWD: '/stale' }, '/repo', pluginRoot)).toBe('/repo');
    expect(resolvePluginWorkspace({}, pluginRoot, pluginRoot)).toBe(pluginRoot);
  });
});

describe('plugin update check', () => {
  const install: PluginInstall = {
    agent: 'claude',
    marketplace: 'nimbalyst',
    version: '0.5.0',
    manifestUrl: 'https://example.test/plugin.json',
  };
  const manifestFetch = (version: string) => (async () => new Response(JSON.stringify({ version }))) as unknown as typeof fetch;

  it('appends the notice once, to the first successful tool result after a newer version is fetched, and caches it', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nim-update-'));
    try {
      const cacheFile = path.join(dir, 'nested', 'update-check.json');
      const check = startUpdateCheck({ install, env: {}, cacheFile, now: () => 1000, fetchImpl: manifestFetch('0.6.0'), log: () => {} });
      await check.settled;
      expect(JSON.parse(readFileSync(cacheFile, 'utf8'))).toEqual({ checkedAt: 1000, latestVersion: '0.6.0' });

      const tools = new ToolMap()
        .register({ definition: { name: 'ok', description: 'Ok.', inputSchema: { type: 'object', properties: {} } }, call: async () => textResult('done') })
        .register({ definition: { name: 'bad', description: 'Bad.', inputSchema: { type: 'object', properties: {} } }, call: async () => textResult('no', true) });
      const info = { name: 'nimbalyst-local', version: 'test' };
      const call = (id: number, name: string) => handleMessage({ jsonrpc: '2.0', id, method: 'tools/call', params: { name } }, tools, info, check.takeNotice) as Promise<any>;

      expect((await call(1, 'bad')).result.content).toHaveLength(1);
      const first = (await call(2, 'ok')).result.content;
      expect(first).toHaveLength(2);
      expect(first[1].text).toContain('Nimbalyst Wiki 0.6.0 is available (installed: 0.5.0)');
      expect(first[1].text).toContain('`claude plugin update nimbalyst-wiki@nimbalyst`');
      expect((await call(3, 'ok')).result.content).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses a fresh cache without fetching, refetches a stale one, and stays quiet when opted out or offline', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nim-update-'));
    try {
      const cacheFile = path.join(dir, 'update-check.json');
      const day = 24 * 60 * 60 * 1000;
      writeFileSync(cacheFile, JSON.stringify({ checkedAt: 0, latestVersion: '0.7.0' }));
      const failFetch = (async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch;

      let fetched = false;
      const noFetch = (async () => {
        fetched = true;
        return new Response('{}');
      }) as unknown as typeof fetch;
      const fresh = startUpdateCheck({ install, env: {}, cacheFile, now: () => day - 1, fetchImpl: noFetch, log: () => {} });
      await fresh.settled;
      expect(fetched).toBe(false);
      expect(fresh.takeNotice()).toContain('Nimbalyst Wiki 0.7.0');

      const optedOut = startUpdateCheck({ install, env: { NIMBALYST_WIKI_NO_UPDATE_CHECK: '1' }, cacheFile, now: () => 2 * day, fetchImpl: noFetch });
      await optedOut.settled;
      expect(fetched).toBe(false);
      expect(optedOut.takeNotice()).toBeNull();

      // Offline with a stale cache: the cached version still counts, and the cache is left alone.
      const logs: string[] = [];
      const offline = startUpdateCheck({ install, env: {}, cacheFile, now: () => 2 * day, fetchImpl: failFetch, log: (line) => logs.push(line) });
      await offline.settled;
      expect(logs[0]).toContain('offline');
      expect(JSON.parse(readFileSync(cacheFile, 'utf8')).checkedAt).toBe(0);
      expect(offline.takeNotice()).toContain('0.7.0');

      // A stale cache is replaced by what the fetch finds; the same version as installed is no notice.
      const current = startUpdateCheck({ install, env: {}, cacheFile, now: () => 2 * day, fetchImpl: manifestFetch('0.5.0'), log: () => {} });
      await current.settled;
      expect(current.takeNotice()).toBeNull();
      expect(JSON.parse(readFileSync(cacheFile, 'utf8')).latestVersion).toBe('0.5.0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects which agent and marketplace installed the plugin, and skips anything else', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'nim-install-'));
    try {
      const codexRoot = path.join(home, '.codex/plugins/cache/nimbalyst-wiki/nimbalyst-wiki/0.5.0');
      const claudeRoot = path.join(home, '.claude/plugins/cache/nimbalyst/nimbalyst-wiki/0.5.0');
      const otherRoot = path.join(home, '.claude/plugins/cache/someone-else/nimbalyst-wiki/0.5.0');
      for (const root of [codexRoot, claudeRoot, otherRoot]) {
        for (const dirName of ['.claude-plugin', '.codex-plugin']) {
          mkdirSync(path.join(root, dirName), { recursive: true });
          writeFileSync(path.join(root, dirName, 'plugin.json'), JSON.stringify({ version: '0.5.0' }));
        }
      }

      const codex = detectPluginInstall({ PWD: '/repo' }, codexRoot, codexRoot);
      expect(codex).toMatchObject({ agent: 'codex', marketplace: 'nimbalyst-wiki', version: '0.5.0' });
      expect(codex?.manifestUrl).toContain('nimbalyst-wiki/main/.codex-plugin/plugin.json');
      const claude = detectPluginInstall({ CLAUDE_PROJECT_DIR: '/repo' }, '/repo', claudeRoot);
      expect(claude).toMatchObject({ agent: 'claude', marketplace: 'nimbalyst' });
      expect(claude?.manifestUrl).toContain('nimbalyst/main/plugins/nimbalyst-wiki/.claude-plugin/plugin.json');

      expect(detectPluginInstall({}, '/repo', otherRoot)).toBeNull();
      expect(detectPluginInstall({}, '/repo', path.join(repoRoot, 'plugins/nimbalyst-wiki'))).toBeNull();

      const notice = startUpdateCheck({ install: { ...codex!, version: '0.4.0' }, env: {}, cacheFile: path.join(home, 'c.json'), now: () => 0, fetchImpl: manifestFetch('0.5.0'), log: () => {} });
      await notice.settled;
      expect(notice.takeNotice()).toContain('run `codex plugin marketplace upgrade nimbalyst-wiki`, then start a new session');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
