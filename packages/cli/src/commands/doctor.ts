/**
 * `nim doctor [--versions] [--json]`: which nim and browser app this is, how
 * they were installed, what is on disk now, the latest version the update
 * check has seen, and the wiki plugins installed for Claude Code and Codex.
 * The same report is the `versions` section of the `wikiDoctor` MCP tool.
 */
import type { ParsedArgs } from '../cli/parse.js';
import { flagBool, flagStr } from '../cli/parse.js';
import { ExitCode } from '../cli/exitCodes.js';
import { detectNpmInstall } from '../mcp/updateCheck.js';
import { versionsReport, type VersionsReport } from '../update/installs.js';

export function formatVersions(report: VersionsReport): string {
  const { nim, viewer, plugins } = report;
  const lines = [
    `nim ${nim.running}`,
    `  installed as: ${nim.install}`,
    `  runs from:    ${nim.executable}`,
  ];
  if (nim.onDisk && nim.restartNeeded) lines.push(`  on disk:      ${nim.onDisk} (restart to use it)`);
  if (nim.latestKnown?.version) lines.push(`  latest known: ${nim.latestKnown.version} (checked ${nim.latestKnown.checkedAt})`);
  lines.push(
    viewer.path
      ? `browser app ${viewer.version ?? '(version unknown)'}\n  from: ${viewer.source}, ${viewer.path}`
      : `browser app: not found (${viewer.problem ?? 'unknown'})`,
  );
  lines.push(plugins.length ? 'wiki plugins:' : 'wiki plugins: none installed for Claude Code or Codex');
  for (const p of plugins) lines.push(`  ${p.agentName}: ${p.plugin}@${p.marketplace} ${p.version}${p.scope === 'user' ? '' : ` (${p.scope} scope)`}`);
  return lines.join('\n') + '\n';
}

export async function runDoctor(args: ParsedArgs, deps: { version: string; entryFile: string }): Promise<number> {
  const report = versionsReport({
    version: deps.version,
    executable: deps.entryFile,
    install: detectNpmInstall(deps.entryFile, deps.version),
    assetsDir: flagStr(args, 'assets'),
    projectRoot: flagStr(args, 'workspace') ?? process.cwd(),
  });
  process.stdout.write(flagBool(args, 'json') ? `${JSON.stringify(report, null, 2)}\n` : formatVersions(report));
  return ExitCode.OK;
}
