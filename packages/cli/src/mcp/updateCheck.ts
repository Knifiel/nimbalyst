/**
 * Tells a plugin user that a newer Nimbalyst Wiki is published. Neither agent
 * updates third-party plugins on its own (Claude Code leaves auto-update off
 * for our marketplaces; Codex has none), and Codex runs no plugin hooks, so the
 * check lives in the local server both agents start. It only notifies: the
 * server never rewrites its own install.
 *
 * At most once a day the server fetches the published manifest and caches the
 * version it saw. The first successful tool result that finds a newer version
 * known carries the notice; a tool call never waits on the fetch.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type PluginAgent = 'claude' | 'codex';

export const UPDATE_CHECK_OPT_OUT = 'NIMBALYST_WIKI_NO_UPDATE_CHECK';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;
const PLUGIN_NAME = 'nimbalyst-wiki';

/** Where each marketplace publishes the manifest its installs update from. */
const MANIFEST_URLS: Record<string, Record<PluginAgent, string>> = {
  nimbalyst: {
    claude: 'https://raw.githubusercontent.com/nimbalyst/nimbalyst/main/plugins/nimbalyst-wiki/.claude-plugin/plugin.json',
    codex: 'https://raw.githubusercontent.com/nimbalyst/nimbalyst/main/plugins/nimbalyst-wiki/.codex-plugin/plugin.json',
  },
  'nimbalyst-wiki': {
    claude: 'https://raw.githubusercontent.com/nimbalyst/nimbalyst-wiki/main/.claude-plugin/plugin.json',
    codex: 'https://raw.githubusercontent.com/nimbalyst/nimbalyst-wiki/main/.codex-plugin/plugin.json',
  },
};

export interface PluginInstall {
  agent: PluginAgent;
  marketplace: string;
  version: string;
  manifestUrl: string;
}

/**
 * The install this server runs from, or null when it is not one we can update:
 * a monorepo checkout, `--plugin-dir`, or a marketplace we don't publish to.
 * Both agents install to `.../plugins/cache/<marketplace>/<plugin>/<version>`.
 * Codex starts the server in the plugin directory with no `CLAUDE_PROJECT_DIR`
 * (see pluginWorkspace.ts); anything else is Claude Code.
 */
export function detectPluginInstall(env: NodeJS.ProcessEnv, cwd: string, pluginRoot: string): PluginInstall | null {
  const parts = path.resolve(pluginRoot).split(path.sep);
  const n = parts.length;
  if (n < 5 || parts[n - 5] !== 'plugins' || parts[n - 4] !== 'cache' || parts[n - 2] !== PLUGIN_NAME) return null;
  const marketplace = parts[n - 3];
  const urls = MANIFEST_URLS[marketplace];
  if (!urls) return null;
  const agent: PluginAgent = !env.CLAUDE_PROJECT_DIR && path.resolve(cwd) === path.resolve(pluginRoot) ? 'codex' : 'claude';
  const manifest = path.join(pluginRoot, agent === 'codex' ? '.codex-plugin' : '.claude-plugin', 'plugin.json');
  let version: unknown;
  try {
    version = JSON.parse(readFileSync(manifest, 'utf8')).version;
  } catch {
    return null;
  }
  if (typeof version !== 'string' || !parseVersion(version)) return null;
  return { agent, marketplace, version, manifestUrl: urls[agent] };
}

function parseVersion(version: string): number[] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  return match ? match.slice(1).map(Number) : null;
}

/** True when `latest` is a higher major.minor.patch than `installed`. Prerelease tags are ignored. */
export function isNewerVersion(latest: string, installed: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(installed);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

export function updateNotice(install: PluginInstall, latest: string): string {
  const steps =
    install.agent === 'codex'
      ? `run \`codex plugin marketplace upgrade ${install.marketplace}\``
      : `run \`claude plugin marketplace update ${install.marketplace}\` and then \`claude plugin update ${PLUGIN_NAME}@${install.marketplace}\``;
  return (
    `Nimbalyst Wiki ${latest} is available (installed: ${install.version}). To update, ${steps}, then start a new session. ` +
    `Tell the user this once, briefly, and do not repeat it. Set ${UPDATE_CHECK_OPT_OUT}=1 to stop these notices.`
  );
}

export const defaultUpdateCacheFile = () => path.join(os.homedir(), '.nimbalyst-wiki', 'update-check.json');

interface CacheEntry {
  checkedAt: number;
  latestVersion: string;
}

function readCache(file: string): CacheEntry | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof parsed?.checkedAt === 'number' && typeof parsed?.latestVersion === 'string') return parsed;
  } catch {
    // Missing or unreadable: treat as never checked.
  }
  return null;
}

export interface UpdateCheckOptions {
  install: PluginInstall;
  env?: NodeJS.ProcessEnv;
  cacheFile?: string;
  now?: () => number;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

export interface UpdateCheck {
  /** The notice the first time a newer version is known, then null for the rest of the process. */
  takeNotice(): string | null;
  /** Settles when the background fetch (if one started) is done. For tests. */
  settled: Promise<void>;
}

export function startUpdateCheck(options: UpdateCheckOptions): UpdateCheck {
  const env = options.env ?? process.env;
  if (env[UPDATE_CHECK_OPT_OUT] && env[UPDATE_CHECK_OPT_OUT] !== '0') {
    return { takeNotice: () => null, settled: Promise.resolve() };
  }
  const { install } = options;
  const cacheFile = options.cacheFile ?? defaultUpdateCacheFile();
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const cached = readCache(cacheFile);
  let latest = cached?.latestVersion ?? null;
  let delivered = false;

  let settled = Promise.resolve();
  if (!cached || now() - cached.checkedAt >= CHECK_INTERVAL_MS) {
    const fetchImpl = options.fetchImpl ?? fetch;
    settled = (async () => {
      try {
        const response = await fetchImpl(install.manifestUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const version = (await response.json())?.version;
        if (typeof version !== 'string' || !parseVersion(version)) throw new Error('manifest has no version');
        latest = version;
        mkdirSync(path.dirname(cacheFile), { recursive: true });
        writeFileSync(cacheFile, `${JSON.stringify({ checkedAt: now(), latestVersion: version } satisfies CacheEntry)}\n`);
      } catch (err) {
        log(`nimbalyst-local: update check against ${install.manifestUrl} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  }

  return {
    takeNotice() {
      if (delivered || !latest || !isNewerVersion(latest, install.version)) return null;
      delivered = true;
      return updateNotice(install, latest);
    },
    settled,
  };
}
