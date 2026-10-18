/**
 * Where Nimbalyst Wiki is installed on this machine and which versions are
 * there: the running `nim`, the Claude Code and Codex plugin installs, and the
 * browser app `nim wiki serve` would use. Shared by `nim update`,
 * `nim doctor` and the `versions` section of `wikiDoctor`.
 *
 * Read-only. Claude Code records plugins in `installed_plugins.json` under its
 * config directory; Codex keeps one cache directory per installed version
 * under `plugins/cache/<marketplace>/<plugin>/`.
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveWikiWebAssets } from '../serve/assets.js';
import {
  isNewerVersion,
  MANIFEST_URLS,
  PLUGIN_NAME,
  readCachedLatest,
  type NpmInstall,
  type PluginAgent,
  type PluginInstall,
  type UnmanagedReason,
} from '../mcp/updateCheck.js';

export const TEAM_PLUGIN_NAME = 'nimbalyst-wiki-team';
const PLUGIN_NAMES = [PLUGIN_NAME, TEAM_PLUGIN_NAME] as const;
export type WikiPluginName = (typeof PLUGIN_NAMES)[number];

export type RunningInstall = PluginInstall | NpmInstall | { kind: 'unmanaged'; reason: UnmanagedReason };

export interface PluginRecord {
  agent: PluginAgent;
  plugin: WikiPluginName;
  marketplace: string;
  version: string;
  /** Claude Code's install scope (`user`, `project`, `local`); Codex installs are always `user`. */
  scope: string;
}

export interface MachineEnv {
  env: NodeJS.ProcessEnv;
  home: string;
}

export const machineEnv = (): MachineEnv => ({ env: process.env, home: os.homedir() });

export const claudeConfigDir = ({ env, home }: MachineEnv) => env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
export const codexHome = ({ env, home }: MachineEnv) => env.CODEX_HOME || path.join(home, '.codex');

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function versionOf(value: unknown): string | null {
  const version = (value as { version?: unknown } | null)?.version;
  return typeof version === 'string' && /^\d+\.\d+\.\d+/.test(version) ? version : null;
}

/** Wiki plugins Claude Code has installed, from its own record of installs. */
export function findClaudePlugins(machine: MachineEnv): PluginRecord[] {
  const file = readJson(path.join(claudeConfigDir(machine), 'plugins', 'installed_plugins.json')) as { plugins?: Record<string, unknown> } | null;
  // Version 2 nests entries under `plugins`, one array per plugin; version 1 kept one object per key at the top.
  const byKey = (file?.plugins ?? file ?? {}) as Record<string, unknown>;
  const records: PluginRecord[] = [];
  for (const [key, value] of Object.entries(byKey)) {
    const match = /^(.+)@(.+)$/.exec(key);
    if (!match || !(PLUGIN_NAMES as readonly string[]).includes(match[1]) || !MANIFEST_URLS[match[2]]) continue;
    for (const entry of Array.isArray(value) ? value : [value]) {
      const version = versionOf(entry);
      if (!version) continue;
      const scope = typeof (entry as { scope?: unknown }).scope === 'string' ? (entry as { scope: string }).scope : 'user';
      records.push({ agent: 'claude', plugin: match[1] as WikiPluginName, marketplace: match[2], version, scope });
    }
  }
  return records;
}

/** The highest version cached for one plugin, reading each version directory's own manifest. */
export function highestCachedVersion(pluginCacheDir: string, manifestDir: '.claude-plugin' | '.codex-plugin'): string | null {
  let best: string | null = null;
  let names: string[] = [];
  try {
    names = readdirSync(pluginCacheDir);
  } catch {
    return null;
  }
  for (const name of names) {
    const version = versionOf(readJson(path.join(pluginCacheDir, name, manifestDir, 'plugin.json')));
    if (version && (!best || isNewerVersion(version, best))) best = version;
  }
  return best;
}

/** Wiki plugins Codex has installed. Codex removes a plugin's cache when it is uninstalled. */
export function findCodexPlugins(machine: MachineEnv): PluginRecord[] {
  const records: PluginRecord[] = [];
  for (const marketplace of Object.keys(MANIFEST_URLS)) {
    for (const plugin of PLUGIN_NAMES) {
      const version = highestCachedVersion(path.join(codexHome(machine), 'plugins', 'cache', marketplace, plugin), '.codex-plugin');
      if (version) records.push({ agent: 'codex', plugin, marketplace, version, scope: 'user' });
    }
  }
  return records;
}

/**
 * The version of `@nimbalyst/cli` installed where `install` lives now. A pnpm
 * update installs into a new store directory, so a global pnpm install is read
 * through the global `node_modules` link rather than the old store path.
 */
export function installedNpmVersion(install: NpmInstall): string | null {
  const parts = install.packageDir.split(path.sep);
  const store = parts.indexOf('.pnpm');
  const packageDir = store > 0 ? path.join(parts.slice(0, store).join(path.sep) || path.sep, '@nimbalyst', 'cli') : install.packageDir;
  return versionOf(readJson(path.join(packageDir, 'package.json')));
}

const AGENT_LABEL: Record<PluginAgent, string> = { claude: 'Claude Code', codex: 'Codex' };
export const agentLabel = (agent: PluginAgent) => AGENT_LABEL[agent];

export function describeInstall(install: RunningInstall): string {
  switch (install.kind) {
    case 'plugin':
      return `${AGENT_LABEL[install.agent]} plugin ${PLUGIN_NAME}@${install.marketplace}`;
    case 'npm':
      return `${install.manager} ${install.global ? 'global install' : 'project dependency'} (${install.packageDir})`;
    default:
      return {
        app: 'the copy bundled with the Nimbalyst app, which updates with the app',
        npx: 'npx, which fetches the latest version on each run',
        checkout: 'a Nimbalyst source checkout',
        unknown: 'an install nim does not recognize',
      }[install.reason];
  }
}

/** The version now on disk for the running install, which differs from the running one after an update. */
export function onDiskVersion(install: RunningInstall): string | null {
  if (install.kind === 'npm') return installedNpmVersion(install);
  if (install.kind === 'plugin' && install.root) {
    return highestCachedVersion(path.dirname(install.root), install.agent === 'codex' ? '.codex-plugin' : '.claude-plugin');
  }
  return null;
}

export interface VersionsReport {
  nim: {
    running: string;
    executable: string;
    install: string;
    onDisk: string | null;
    restartNeeded: boolean;
    latestKnown: { version: string | null; checkedAt: string } | null;
  };
  viewer: { version: string | null; path: string | null; source: string; problem?: string };
  plugins: Array<PluginRecord & { agentName: string }>;
}

export interface VersionsOptions {
  version: string;
  executable: string;
  install: RunningInstall;
  /** `--assets` the server was started with (the plugin passes its bundled `web/`). */
  assetsDir?: string;
  projectRoot?: string;
  machine?: MachineEnv;
  cacheFile?: string;
}

export function versionsReport(options: VersionsOptions): VersionsReport {
  const { install } = options;
  const machine = options.machine ?? machineEnv();
  const onDisk = onDiskVersion(install);
  const cached = install.kind === 'unmanaged' ? null : readCachedLatest(install.url, options.cacheFile);

  let viewer: VersionsReport['viewer'];
  if (install.kind === 'plugin' && options.assetsDir) {
    // The plugin's web/ is built with the plugin and carries no package.json of its own.
    viewer = { version: install.version, path: options.assetsDir, source: 'bundled with the plugin' };
  } else {
    const resolved = resolveWikiWebAssets({ flag: options.assetsDir, projectRoot: options.projectRoot });
    viewer = resolved.ok
      ? { version: resolved.assets.version, path: resolved.assets.dir, source: { flag: '--assets', installed: 'installed package', workspace: 'monorepo workspace package' }[resolved.assets.source] }
      : { version: null, path: null, source: 'none', problem: resolved.detail };
  }

  return {
    nim: {
      running: options.version,
      executable: options.executable,
      install: describeInstall(install),
      onDisk,
      restartNeeded: Boolean(onDisk && onDisk !== options.version),
      latestKnown: cached ? { version: cached.latestVersion, checkedAt: new Date(cached.checkedAt).toISOString() } : null,
    },
    viewer,
    plugins: [...findClaudePlugins(machine), ...findCodexPlugins(machine)].map((record) => ({ ...record, agentName: AGENT_LABEL[record.agent] })),
  };
}

/** The first executable named `command` on PATH (with Windows extensions), or null. */
export function findOnPath(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const exts = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext.toLowerCase());
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Exec = (command: string, args: string[]) => Promise<ExecResult>;

/**
 * Runs a command without a shell and collects its output. Windows needs a
 * shell to start the `.cmd` shims npm, pnpm and the agents install, and the
 * arguments here are fixed words and version numbers, never user text.
 */
export const execCommand: Exec = (command, args) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (err) => resolve({ code: 127, stdout, stderr: stderr + err.message }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
