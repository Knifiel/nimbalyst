/**
 * `nim wiki move-to-team [--org <id> --project <id>] [--dry-run] [--json]`:
 * the local wiki into the team project this repository is bound to. See
 * localWiki/moveToTeam.ts; the `moveLocalWikiToTeam` MCP tool runs the same code.
 */
import type { ParsedArgs } from '../cli/parse.js';
import { flagBool, flagStr } from '../cli/parse.js';
import { ExitCode, usageError } from '../cli/exitCodes.js';
import { safeText } from '../cli/output.js';
import { moveLocalWikiToTeam, type MoveReport } from '../localWiki/moveToTeam.js';
import { editorModelsFromWikiWeb } from '../mcp/editorTools.js';
import type { OpenedWiki } from '../localWiki/open.js';

function describe(report: MoveReport): string {
  const { counts } = report;
  const target = report.project ? `${report.project.projectName ?? report.project.projectId} (${report.project.orgId})` : 'no project checked';
  const lines = [
    `${report.dryRun ? 'Would move' : 'Moved'} ${counts.pages} pages, ${counts.editorPages} editor pages, ${counts.typedPages} typed pages, ${counts.types} types and ${counts.files} linked files to ${safeText(target)}`,
  ];
  if (report.skipped.length) {
    lines.push(`Not moved (kept in the local wiki): ${report.skipped.map((s) => `${safeText(s.title)} (${s.reason})`).join(', ')}`);
  }
  if (!report.dryRun) {
    lines.push(
      `${report.created ?? 0} created, ${report.updated ?? 0} updated, ${report.editorPagesWritten ?? 0} editor pages written, ` +
        `${report.filesUploaded ?? 0} files uploaded, ${report.linksRewritten ?? 0} links rewritten in ${report.batches} calls`,
    );
    for (const error of report.errors ?? []) lines.push(`  error: ${safeText(error.title ?? error.localId)}: ${safeText(error.message)} (${error.code})`);
    for (const warning of report.warnings ?? []) lines.push(`  left as written: ${safeText(warning.title ?? warning.localId)}: ${safeText(warning.message)}`);
    if (report.migratedTo) lines.push('Verified. The local wiki is marked as moved; its files are kept.');
  }
  if (report.homeLink) lines.push(`Home: ${report.homeLink}`);
  if (report.note) lines.push(report.note);
  return lines.join('\n');
}

export async function runMoveToTeam(args: ParsedArgs, opened: OpenedWiki, version: string): Promise<number> {
  const org = flagStr(args, 'org');
  const project = flagStr(args, 'project');
  if (Boolean(org) !== Boolean(project)) throw usageError('Pass --org and --project together.');
  const report = await moveLocalWikiToTeam(opened, {
    project: org && project ? { orgId: org, projectId: project } : undefined,
    dryRun: flagBool(args, 'dry-run'),
  }, { loadEditorModels: editorModelsFromWikiWeb({ assetsDir: flagStr(args, 'assets'), version }) });
  process.stdout.write((flagBool(args, 'json') ? JSON.stringify(report, null, 2) : describe(report)) + '\n');
  return report.verified === false ? ExitCode.CONNECTION : ExitCode.OK;
}
