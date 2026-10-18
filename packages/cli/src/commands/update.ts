/**
 * `nim update [--check] [--dry-run] [--only cli|claude|codex]`: bring every
 * Nimbalyst Wiki install on this machine up to the published version.
 *
 * - the `nim` this command runs from, through npm or pnpm (the browser app is
 *   a pinned dependency of `@nimbalyst/cli`, so it comes along);
 * - the Claude Code plugin, through `claude plugin marketplace update` and
 *   `claude plugin update`, which work even where the Claude desktop app sets
 *   DISABLE_AUTOUPDATER (that only stops automatic updates);
 * - the Codex plugin, through `codex plugin marketplace upgrade`, which
 *   installs the new version on its own.
 *
 * Each install is checked against what is on disk afterwards: a command that
 * exits 0 but leaves the old version is a failure. Nothing is run with sudo;
 * a global prefix this user cannot write to gets the exact command to run.
 * The update check in mcp/updateCheck.ts only ever points people here.
 */
import os from 'node:os';
import type { ParsedArgs } from '../cli/parse.js';
import { flagBool, flagStr } from '../cli/parse.js';
import { ExitCode, usageError } from '../cli/exitCodes.js';
import {
  CLI_PACKAGE,
  detectNpmInstall,
  fetchLatestVersion,
  isNewerVersion,
  MANIFEST_URLS,
  NPM_LATEST_URL,
  refreshCachedLatest,
  type NpmInstall,
} from '../mcp/updateCheck.js';
import {
  agentLabel,
  describeInstall,
  execCommand,
  findClaudePlugins,
  findCodexPlugins,
  findOnPath,
  installedNpmVersion,
  type Exec,
  type MachineEnv,
  type PluginRecord,
} from '../update/installs.js';

type TargetId = 'cli' | 'claude' | 'codex';
const TARGET_IDS: TargetId[] = ['cli', 'claude', 'codex'];

interface Target {
  id: TargetId;
  label: string;
  installed: string;
  /** Null when the published version could not be read; `note` says why. */
  latest: string | null;
  note?: string;
  /** Commands that update it, in order. Empty when nim cannot run them here; `manual` has them. */
  steps: Array<[string, string[]]>;
  manual: string[];
  /** The version on disk now. */
  verify(): string | null;
  restart: string;
}

export interface UpdateDeps {
  version: string;
  entryFile: string;
  machine?: MachineEnv;
  fetchImpl?: typeof fetch;
  exec?: Exec;
  which?: (command: string) => string | null;
  out?: (text: string) => void;
}

const commandLine = ([command, args]: [string, string[]]) => [command, ...args].join(' ');

async function latestFrom(url: string, fetchImpl: typeof fetch | undefined, cache: Map<string, Promise<string>>): Promise<{ version: string | null; error?: string }> {
  if (!cache.has(url)) cache.set(url, fetchLatestVersion(url, fetchImpl));
  try {
    return { version: await cache.get(url)! };
  } catch (err) {
    return { version: null, error: `could not read the published version (${err instanceof Error ? err.message : String(err)})` };
  }
}

function npmSteps(install: NpmInstall, latest: string): Array<[string, string[]]> {
  const spec = `${CLI_PACKAGE}@${latest}`;
  return [install.manager === 'pnpm' ? ['pnpm', ['add', '-g', spec]] : ['npm', ['install', '-g', spec]]];
}

async function cliTarget(deps: UpdateDeps, fetches: Map<string, Promise<string>>): Promise<Target> {
  const install = detectNpmInstall(deps.entryFile, deps.version);
  const base = { id: 'cli' as const, installed: deps.version, restart: 'Agent sessions using `nim mcp`: start a new session. A running `nim wiki serve`: stop it and start it again.' };
  if (install.kind !== 'npm') {
    return { ...base, label: 'nim', latest: null, note: `this nim is ${describeInstall(install)}; npm has nothing to update`, steps: [], manual: [], verify: () => deps.version };
  }
  const { version: latest, error } = await latestFrom(NPM_LATEST_URL, deps.fetchImpl, fetches);
  const label = `nim (${install.manager}${install.global ? ' global' : ''})`;
  if (!install.global) {
    const note = `nim is a dependency of the project at ${install.packageDir.replace(/[\\/]node_modules[\\/]@nimbalyst[\\/]cli$/, '')}; update it there with that project's package manager`;
    return { ...base, label, latest, note: error ?? note, steps: [], manual: latest ? [`${install.manager} ${install.manager === 'pnpm' ? 'add' : 'install'} ${CLI_PACKAGE}@${latest}`] : [], verify: () => installedNpmVersion(install) };
  }
  const steps = latest ? npmSteps(install, latest) : [];
  return { ...base, label, latest, note: error, steps, manual: steps.map(commandLine), verify: () => installedNpmVersion(install) };
}

function pluginTargets(
  agent: 'claude' | 'codex',
  records: PluginRecord[],
  deps: UpdateDeps,
  fetches: Map<string, Promise<string>>,
  read: () => PluginRecord[],
): Promise<Target[]> {
  const onPath = (deps.which ?? findOnPath)(agent) !== null;
  const byMarketplace = new Map<string, PluginRecord[]>();
  for (const record of records) byMarketplace.set(record.marketplace, [...(byMarketplace.get(record.marketplace) ?? []), record]);
  return Promise.all(
    [...byMarketplace].map(async ([marketplace, installed]): Promise<Target> => {
      const { version: latest, error } = await latestFrom(MANIFEST_URLS[marketplace][agent], deps.fetchImpl, fetches);
      const lowest = (list: PluginRecord[]) => list.map((r) => r.version).reduce((a, b) => (isNewerVersion(a, b) ? b : a));
      const userScope = installed.filter((r) => r.scope === 'user');
      const otherScope = installed.filter((r) => r.scope !== 'user');
      // Both plugins live in one marketplace and share its version, so the marketplace refresh runs once.
      const steps: Array<[string, string[]]> =
        agent === 'claude'
          ? [['claude', ['plugin', 'marketplace', 'update', marketplace]], ...userScope.map((r): [string, string[]] => ['claude', ['plugin', 'update', `${r.plugin}@${marketplace}`]])]
          : [['codex', ['plugin', 'marketplace', 'upgrade', marketplace]]];
      const scopeNote = otherScope.length
        ? `installed for a ${otherScope.map((r) => r.scope).join(' and ')} scope too; run \`claude plugin update ${otherScope[0].plugin}@${marketplace} --scope ${otherScope[0].scope}\` in that project`
        : undefined;
      const missing = onPath ? undefined : `\`${agent}\` is not on PATH; run these yourself`;
      const names = [...new Set(installed.map((r) => r.plugin))].join(' + ');
      return {
        id: agent,
        label: `${agentLabel(agent)} plugin ${names}@${marketplace}`,
        installed: lowest(userScope.length ? userScope : installed),
        latest,
        note: error ?? missing ?? scopeNote,
        steps: onPath && userScope.length ? steps : [],
        manual: steps.map(commandLine),
        verify: () => {
          const now = read().filter((r) => r.marketplace === marketplace && (userScope.length === 0 || r.scope === 'user'));
          return now.length ? lowest(now) : null;
        },
        restart: agent === 'claude' ? 'Claude Code: run /reload-plugins in open sessions, or start a new one.' : 'Codex: start a new session.',
      };
    }),
  );
}

export async function runUpdate(args: ParsedArgs, deps: UpdateDeps): Promise<number> {
  if (flagBool(args, 'refresh-cache')) {
    // Started detached by the terminal notice (cli/updateNotice.ts) to record the latest version. Prints nothing.
    const install = detectNpmInstall(deps.entryFile, deps.version);
    if (install.kind === 'npm') await refreshCachedLatest(install.url, { fetchImpl: deps.fetchImpl });
    return ExitCode.OK;
  }
  const out = deps.out ?? ((text: string) => process.stdout.write(text));
  const only = flagStr(args, 'only');
  if (only && !TARGET_IDS.includes(only as TargetId)) throw usageError(`--only takes one of ${TARGET_IDS.join(', ')}`);
  const wanted = (id: TargetId) => !only || only === id;
  const checkOnly = flagBool(args, 'check');
  const dryRun = flagBool(args, 'dry-run');
  const machine = deps.machine ?? { env: process.env, home: os.homedir() };
  const exec = deps.exec ?? execCommand;
  const fetches = new Map<string, Promise<string>>();

  const targets: Target[] = [];
  if (wanted('cli')) targets.push(await cliTarget(deps, fetches));
  if (wanted('claude')) targets.push(...(await pluginTargets('claude', findClaudePlugins(machine), deps, fetches, () => findClaudePlugins(machine))));
  if (wanted('codex')) targets.push(...(await pluginTargets('codex', findCodexPlugins(machine), deps, fetches, () => findCodexPlugins(machine))));
  if (wanted('claude') && wanted('codex') && !targets.some((t) => t.id !== 'cli')) out('No Nimbalyst Wiki plugin is installed for Claude Code or Codex.\n');

  const outdated = targets.filter((t) => t.latest && isNewerVersion(t.latest, t.installed));
  for (const target of targets) {
    const state = !target.latest ? 'not checked' : outdated.includes(target) ? `${target.installed} -> ${target.latest}` : `${target.installed}, up to date`;
    out(`${target.label}: ${state}${target.note ? `\n  ${target.note}` : ''}\n`);
  }
  if (checkOnly) return outdated.length ? ExitCode.NOT_FOUND : ExitCode.OK;
  if (!outdated.length) return ExitCode.OK;

  const updated: Target[] = [];
  let failed = 0;
  for (const target of outdated) {
    if (!target.steps.length) {
      if (target.manual.length) out(`\nTo update ${target.label}, run:\n${target.manual.map((line) => `  ${line}\n`).join('')}`);
      continue;
    }
    out(`\nUpdating ${target.label}\n`);
    let stepFailed = false;
    for (const step of target.steps) {
      out(`  ${dryRun ? 'would run' : 'running'}: ${commandLine(step)}\n`);
      if (dryRun) continue;
      const result = await exec(...step);
      if (result.code === 0) continue;
      stepFailed = true;
      const detail = (result.stderr || result.stdout).trim().split('\n').slice(-6).map((line) => `    ${line}`).join('\n');
      out(`  failed (exit ${result.code}):\n${detail}\n`);
      if (/EACCES|permission denied/i.test(result.stderr)) {
        out(`  nim cannot write to the global install directory and does not use sudo. Run it yourself:\n    ${commandLine(step)}\n`);
      }
      break;
    }
    if (dryRun) continue;
    const now = target.verify();
    if (stepFailed) {
      failed++;
    } else if (now !== target.latest) {
      failed++;
      out(`  the commands finished, but ${target.label} is still ${now ?? 'missing'} (expected ${target.latest})\n`);
    } else {
      updated.push(target);
      out(`  ${target.installed} -> ${now}\n`);
    }
  }

  if (updated.length) {
    out('\nStill running the old version until restarted:\n');
    for (const restart of new Set(updated.map((t) => t.restart))) out(`  ${restart}\n`);
  }
  return failed ? ExitCode.CONNECTION : ExitCode.OK;
}
