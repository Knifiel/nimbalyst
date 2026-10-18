// @vitest-environment node
/**
 * `nim update` against a fake machine: install records under a temp home,
 * published versions from a fake fetch, and an exec that plays npm, claude and
 * codex by rewriting those records. Nothing real is installed or fetched.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { parseArgs } from '../../cli/parse.js';
import { runUpdate, type UpdateDeps } from '../update.js';
import { versionsReport, type ExecResult } from '../../update/installs.js';
import { terminalNotice, wantsTerminalNotice } from '../../cli/updateNotice.js';
import { detectNpmInstall } from '../../mcp/updateCheck.js';

let home = '';

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'nim-update-cmd-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const write = (file: string, value: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
};

/** A global npm install of nim at `version`, returning the running entry file. */
function npmGlobal(version: string): string {
  const packageDir = path.join(home, 'prefix', 'lib', 'node_modules', '@nimbalyst', 'cli');
  write(path.join(packageDir, 'package.json'), { name: '@nimbalyst/cli', version });
  return path.join(packageDir, 'dist', 'bin', 'cli.js');
}

const published = (versions: Record<string, string>) =>
  (async (url: string) => {
    const key = Object.keys(versions).find((k) => String(url).includes(k));
    return key ? new Response(JSON.stringify({ version: versions[key] })) : new Response('', { status: 404 });
  }) as unknown as typeof fetch;

function harness(entryFile: string, version: string, onExec: (command: string, args: string[]) => ExecResult = () => ({ code: 0, stdout: '', stderr: '' })) {
  const calls: string[] = [];
  let output = '';
  const deps: UpdateDeps = {
    version,
    entryFile,
    machine: { env: {}, home },
    fetchImpl: published({ 'registry.npmjs.org': '0.10.0', 'nimbalyst-wiki/main': '0.10.0' }),
    exec: async (command, args) => {
      calls.push([command, ...args].join(' '));
      return onExec(command, args);
    },
    which: () => '/usr/bin/found',
    out: (text) => (output += text),
  };
  return { deps, calls, output: () => output };
}

describe('nim update', () => {
  it('updates a global npm nim and confirms the new version is on disk', async () => {
    const entry = npmGlobal('0.9.0');
    const { deps, calls, output } = harness(entry, '0.9.0', () => {
      npmGlobal('0.10.0');
      return { code: 0, stdout: '', stderr: '' };
    });

    const code = await runUpdate(parseArgs(['update', '--only', 'cli']), deps);

    expect(calls).toEqual(['npm install -g @nimbalyst/cli@0.10.0']);
    expect(code).toBe(0);
    expect(output()).toContain('nim (npm global): 0.9.0 -> 0.10.0');
    expect(output()).toContain('Still running the old version until restarted');
  });

  it('updates the Claude Code plugins with one marketplace refresh and the Codex plugin with its upgrade', async () => {
    const claudeRecord = (version: string) => ({ scope: 'user', installPath: '/x', version });
    const claudeFile = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
    const claudeAt = (version: string) =>
      write(claudeFile, { version: 2, plugins: { 'nimbalyst-wiki@nimbalyst': [claudeRecord(version)], 'nimbalyst-wiki-team@nimbalyst': [claudeRecord(version)], 'other@nimbalyst': [claudeRecord('0.1.0')] } });
    const codexAt = (version: string) => write(path.join(home, '.codex', 'plugins', 'cache', 'nimbalyst-wiki', 'nimbalyst-wiki', version, '.codex-plugin', 'plugin.json'), { version });
    claudeAt('0.8.0');
    codexAt('0.8.0');

    const { deps, calls, output } = harness(path.join(home, 'checkout', 'packages', 'cli', 'dist', 'bin', 'cli.js'), '0.0.0-dev', (command, args) => {
      if (command === 'claude' && args[1] === 'update') claudeAt('0.10.0');
      if (command === 'codex') codexAt('0.10.0');
      return { code: 0, stdout: '', stderr: '' };
    });

    expect(await runUpdate(parseArgs(['update']), deps)).toBe(0);
    expect(calls).toEqual([
      'claude plugin marketplace update nimbalyst',
      'claude plugin update nimbalyst-wiki@nimbalyst',
      'claude plugin update nimbalyst-wiki-team@nimbalyst',
      'codex plugin marketplace upgrade nimbalyst-wiki',
    ]);
    expect(output()).toContain('a Nimbalyst source checkout; npm has nothing to update');
    expect(output()).toContain('Claude Code plugin nimbalyst-wiki + nimbalyst-wiki-team@nimbalyst: 0.8.0 -> 0.10.0');
    expect(output()).toContain('Claude Code: run /reload-plugins');
    expect(output()).toContain('Codex: start a new session.');
  });

  it('reports a command that leaves the old version as failed, stops on EACCES without sudo, and runs nothing for --dry-run or --check', async () => {
    const entry = npmGlobal('0.9.0');

    const unchanged = harness(entry, '0.9.0');
    expect(await runUpdate(parseArgs(['update', '--only', 'cli']), unchanged.deps)).toBe(3);
    expect(unchanged.output()).toContain('the commands finished, but nim (npm global) is still 0.9.0 (expected 0.10.0)');

    const denied = harness(entry, '0.9.0', () => ({ code: 243, stdout: '', stderr: 'npm error code EACCES\nnpm error syscall mkdir' }));
    expect(await runUpdate(parseArgs(['update', '--only', 'cli']), denied.deps)).toBe(3);
    expect(denied.calls).toEqual(['npm install -g @nimbalyst/cli@0.10.0']);
    expect(denied.output()).toContain('does not use sudo. Run it yourself:\n    npm install -g @nimbalyst/cli@0.10.0');

    const dry = harness(entry, '0.9.0');
    expect(await runUpdate(parseArgs(['update', '--only', 'cli', '--dry-run']), dry.deps)).toBe(0);
    expect(dry.calls).toEqual([]);
    expect(dry.output()).toContain('would run: npm install -g @nimbalyst/cli@0.10.0');

    const check = harness(entry, '0.9.0');
    expect(await runUpdate(parseArgs(['update', '--check']), check.deps)).toBe(1);
    expect(check.calls).toEqual([]);
  });
});

describe('versions report', () => {
  it('says how nim was installed, that an update on disk needs a restart, the latest known version, and the installed plugins', () => {
    const entry = npmGlobal('0.9.0');
    npmGlobal('0.10.0');
    const cacheFile = path.join(home, 'update-check.json');
    write(cacheFile, { 'https://registry.npmjs.org/@nimbalyst/cli/latest': { checkedAt: 0, latestVersion: '0.10.0', ok: true } });
    write(path.join(home, '.codex', 'plugins', 'cache', 'nimbalyst', 'nimbalyst-wiki', '0.8.0', '.codex-plugin', 'plugin.json'), { version: '0.8.0' });

    const report = versionsReport({
      version: '0.9.0',
      executable: entry,
      install: detectNpmInstall(entry, '0.9.0'),
      assetsDir: path.join(home, 'no-such-viewer'),
      machine: { env: {}, home },
      cacheFile,
    });

    expect(report.nim).toMatchObject({ running: '0.9.0', onDisk: '0.10.0', restartNeeded: true, latestKnown: { version: '0.10.0', checkedAt: '1970-01-01T00:00:00.000Z' } });
    expect(report.nim.install).toBe(`npm global install (${path.join(home, 'prefix', 'lib', 'node_modules', '@nimbalyst', 'cli')})`);
    expect(report.viewer).toMatchObject({ path: null, source: 'none' });
    expect(report.plugins).toEqual([{ agent: 'codex', agentName: 'Codex', plugin: 'nimbalyst-wiki', marketplace: 'nimbalyst', version: '0.8.0', scope: 'user' }]);
  });
});

describe('terminal update notice', () => {
  it('prints one stderr line for an interactive npm install only, and never for machine output, mcp or update', async () => {
    expect(wantsTerminalNotice(parseArgs(['wiki', 'list']), true)).toBe(true);
    expect(wantsTerminalNotice(parseArgs(['wiki', 'list']), false)).toBe(false);
    for (const argv of [['wiki', 'list', '--json'], ['tracker', 'list', '--csv'], ['tracker', 'list', '-q'], ['mcp'], ['update']]) {
      expect(wantsTerminalNotice(parseArgs(argv), true)).toBe(false);
    }

    const cacheFile = path.join(home, 'update-check.json');
    const url = 'https://registry.npmjs.org/@nimbalyst/cli/latest';
    const entryFile = npmGlobal('0.9.0');
    const refreshed: string[] = [];
    const notice = (now: number, env: NodeJS.ProcessEnv = {}) => terminalNotice({ entryFile, version: '0.9.0', env, cacheFile, now: () => now, refresh: (file) => refreshed.push(file) });

    // Never checked: nothing to say yet; a refresh starts in the background and the check is claimed.
    expect(notice(1000)).toBeNull();
    expect(refreshed).toEqual([entryFile]);
    expect(JSON.parse(readFileSync(cacheFile, 'utf8'))[url]).toEqual({ checkedAt: 1000, latestVersion: null, ok: false });
    expect(notice(2000)).toBeNull();
    expect(refreshed).toHaveLength(1);

    // What the background refresh wrote is shown on the next command, without another refresh that day.
    write(cacheFile, { [url]: { checkedAt: 3000, latestVersion: '0.10.0', ok: true } });
    expect(notice(4000)).toBe('\nnim 0.10.0 is available (you have 0.9.0). Run `nim update` to update.\n');
    expect(refreshed).toHaveLength(1);
    expect(notice(4000, { NIMBALYST_WIKI_NO_UPDATE_CHECK: '1' })).toBeNull();

    expect(terminalNotice({ entryFile: path.join(home, 'packages', 'cli', 'dist', 'bin', 'cli.js'), version: '0.9.0', env: {}, cacheFile, refresh: (file) => refreshed.push(file) })).toBeNull();
    expect(refreshed).toHaveLength(1);
  });
});
