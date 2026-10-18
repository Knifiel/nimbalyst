/**
 * The terminal half of the update check (mcp/updateCheck.ts): one line on
 * stderr after a command, when a newer `nim` is published. Only for a person
 * at an interactive terminal: never on stdout, never when stderr is piped or
 * the output is for a machine (`--json`, `--csv`, `--quiet`), and not for
 * `nim mcp` (which tells the agent instead) or `nim update` (which reports
 * versions itself).
 *
 * A command never waits on the network: the notice comes from the cache, and
 * a due refresh runs in a detached `nim update --refresh-cache` that outlives
 * this process, so the next command knows. (Waiting here does not work: an
 * aborted fetch still holds the process open until its DNS lookup finishes.)
 */
import { spawn } from 'node:child_process';
import type { ParsedArgs } from './parse.js';
import { flagBool } from './parse.js';
import {
  defaultUpdateCacheFile,
  detectNpmInstall,
  isCheckDue,
  isNewerVersion,
  readCachedLatest,
  updateChecksDisabled,
  writeCacheEntry,
} from '../mcp/updateCheck.js';

const SILENT_NOUNS = new Set(['mcp', 'update']);
const MACHINE_FLAGS = ['json', 'csv', 'quiet'];

export function wantsTerminalNotice(args: ParsedArgs, stderrIsTTY: boolean): boolean {
  if (!stderrIsTTY || !args.noun || SILENT_NOUNS.has(args.noun)) return false;
  return !MACHINE_FLAGS.some((flag) => flagBool(args, flag));
}

/** Starts `nim update --refresh-cache` from the same bundle, detached, and does not wait for it. */
function refreshInBackground(entryFile: string): void {
  const child = spawn(process.execPath, [entryFile, 'update', '--refresh-cache'], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
}

export interface TerminalNoticeOptions {
  entryFile: string;
  version: string;
  env?: NodeJS.ProcessEnv;
  cacheFile?: string;
  now?: () => number;
  refresh?: (entryFile: string) => void;
}

/** The line to print after the command, or null. Starts a background refresh when one is due. */
export function terminalNotice(options: TerminalNoticeOptions): string | null {
  if (updateChecksDisabled(options.env ?? process.env)) return null;
  const install = detectNpmInstall(options.entryFile, options.version);
  if (install.kind !== 'npm') return null;
  const cacheFile = options.cacheFile ?? defaultUpdateCacheFile();
  const now = (options.now ?? Date.now)();
  const cached = readCachedLatest(install.url, cacheFile);
  if (isCheckDue(cached, now)) {
    try {
      // Claim the check before starting it, so commands run in the next hour don't each start one.
      // The refresh overwrites this on success; if it fails, the claim expires like any failure.
      writeCacheEntry(cacheFile, install.url, { checkedAt: now, latestVersion: cached?.latestVersion ?? null, ok: false });
      (options.refresh ?? refreshInBackground)(options.entryFile);
    } catch {
      // No writable cache: skip the check rather than start one on every command.
    }
  }
  const latest = cached?.latestVersion;
  return latest && isNewerVersion(latest, options.version) ? `\nnim ${latest} is available (you have ${options.version}). Run \`nim update\` to update.\n` : null;
}
