/**
 * Moves the whole local wiki to the team project this repository resolves to,
 * shared by `nim wiki move-to-team` and the `moveLocalWikiToTeam` MCP tool.
 * Page bodies go from the files to the server and never into the report.
 *
 * Nothing local is deleted or moved (.claude/rules/destructive-data-paths.md):
 * the files stay as the recoverable copy. Only after a verified import (every
 * page reported, no errors, Home reads back) is the move recorded as
 * `migratedTo` in `.nimbalyst/local-wiki.json` and a banner line put on the
 * local Home. Until then a re-run resumes through the server's upsert.
 */
import { CliError, ExitCode } from '../cli/exitCodes.js';
import { resolveServer } from '../cloud/config.js';
import { loadCredentials } from '../cloud/credentials.js';
import { callTool } from '../cloud/pagesClient.js';
import { resolveTeamsTarget, type ProjectPin } from '../cloud/repo.js';
import { importToTeam, pacedCaller, planBatches, planTypeBatches, type ImportDeps, type ImportError, type ToolCaller } from '../cloud/teamImport.js';
import { readMigratedTo, writeMigratedTo, type MigratedTo } from './locate.js';
import type { OpenedWiki } from './open.js';
import { collectLocalWiki, MIGRATION_BANNER_PREFIX, migrationBanner } from './teamExport.js';

export interface MoveOptions {
  project?: ProjectPin;
  dryRun?: boolean;
}

export interface MoveDeps extends Omit<ImportDeps, 'call'> {
  /** The team server call; default `callTool` against `NIM_SERVER` with the `nim login` credential. */
  call?: ToolCaller;
  clock?: () => Date;
}

export interface MoveReport {
  dryRun: boolean;
  project: { orgId: string; projectId: string; projectName?: string } | null;
  counts: { pages: number; typedPages: number; types: number; skipped: number };
  /** Editor pages and the like that have no team import yet; still in the local wiki. */
  skipped: Array<{ title: string; reason: string }>;
  batches: number;
  created?: number;
  updated?: number;
  linksRewritten?: number;
  errors?: Array<ImportError & { title?: string }>;
  verified?: boolean;
  homeLink?: string;
  migratedTo?: MigratedTo;
  bannerWritten?: boolean;
  note?: string;
}

/** A refusal the agent or user acts on: not signed in, repo not bound, already moved elsewhere. */
export class MoveRefusal extends CliError {
  constructor(message: string, readonly next?: string) {
    super(ExitCode.USAGE, message);
    this.name = 'MoveRefusal';
  }
}

export async function moveLocalWikiToTeam(opened: OpenedWiki, options: MoveOptions, deps: MoveDeps = {}): Promise<MoveReport> {
  const exported = await collectLocalWiki(opened.wiki);
  const typedPages = exported.pages.filter((page) => page.kind === 'typedPage').length;
  const report: MoveReport = {
    dryRun: options.dryRun === true,
    project: null,
    counts: { pages: exported.pages.length - typedPages, typedPages, types: exported.types.length, skipped: exported.skipped.length },
    skipped: exported.skipped.map(({ title, reason }) => ({ title, reason })),
    batches: planTypeBatches(exported.types).batches.length + planBatches(exported.pages).batches.length,
  };

  const server = resolveServer();
  if (!deps.call && !loadCredentials(server)) {
    if (report.dryRun) return { ...report, note: 'Not signed in to Nimbalyst Teams yet, so no target project was checked. Call teamSignIn (or run nim login).' };
    throw new MoveRefusal('Not signed in to Nimbalyst Teams on this machine. Call teamSignIn (or run `nim login`), then try again.', 'teamSignIn');
  }
  const call = pacedCaller({ ...deps, call: deps.call ?? ((name, args) => callTool(server, name, args)) });

  const target = resolveTeamsTarget(opened.projectRoot, options.project ? { project: options.project } : {});
  const base = { ...(target.repo ? { repo: target.repo } : {}), ...(target.project ? { project: target.project } : {}) };
  const status = await call('pages_status', base);
  if (status?.state !== 'bound' || !status.project?.orgId || !status.project?.projectId) {
    throw new MoveRefusal(
      status?.state === 'ambiguous'
        ? 'This repository resolves to several team projects. Pass `project` ({ orgId, projectId }) for the one to move into.'
        : 'This repository is not connected to a team project yet. Create or bind one first (the /nimbalyst-wiki:team skill walks through it).',
      status?.state === 'ambiguous' ? 'project' : 'team_create',
    );
  }
  const project = { orgId: String(status.project.orgId), projectId: String(status.project.projectId) };
  report.project = { ...project, ...(status.project.projectName ? { projectName: String(status.project.projectName) } : {}) };

  const previous = readMigratedTo(opened.projectRoot);
  if (previous && (previous.orgId !== project.orgId || previous.projectId !== project.projectId)) {
    throw new MoveRefusal(
      `This local wiki was already moved to another team project (${previous.orgId}/${previous.projectId}) on ${previous.at}. ` +
        'Moving it again would make a second copy; remove `migratedTo` from .nimbalyst/local-wiki.json first if that is what the user wants.',
    );
  }
  if (report.dryRun) return { ...report, homeLink: typeof status.homeLink === 'string' ? status.homeLink : undefined };

  const wikiId = await opened.wiki.wikiId();
  const outcome = await importToTeam(exported, { repo: target.repo, project, wikiId }, call);
  const titles = new Map(exported.pages.map((page) => [page.localId, page.title]));
  const home = exported.homeLocalId ? outcome.idMap[exported.homeLocalId] : undefined;
  // The imported Home is the user's own; the project's seeded Home stays as it is, unlinked from here.
  const homeLink = home?.link ?? (typeof status.homeLink === 'string' ? status.homeLink : undefined);
  Object.assign(report, {
    batches: outcome.batches,
    created: outcome.created,
    updated: outcome.updated,
    linksRewritten: outcome.linksRewritten,
    errors: outcome.errors.map((error) => ({ ...error, title: titles.get(error.localId) })),
    homeLink,
  });

  let verified = outcome.complete;
  if (verified && exported.homeLocalId) {
    verified = Boolean(home) && (await readsBack(call, base, project, home!.uri ?? home!.link));
  }
  report.verified = verified;
  if (!verified) {
    report.note = 'The import is not verified, so the local wiki is not marked as moved. Fix the errors, then run the move again; it resumes.';
    return report;
  }

  const migratedTo: MigratedTo = { ...project, at: (deps.clock?.() ?? new Date()).toISOString() };
  writeMigratedTo(opened.projectRoot, migratedTo);
  report.migratedTo = migratedTo;
  report.bannerWritten = exported.homeLocalId && homeLink ? await writeBanner(opened, exported.homeLocalId, homeLink) : false;
  return report;
}

async function readsBack(call: ToolCaller, base: Record<string, unknown>, project: ProjectPin, filePath: string): Promise<boolean> {
  try {
    const result = await call('readCollabDoc', { ...base, project, filePath });
    return result !== undefined && result !== null;
  } catch {
    return false;
  }
}

/** One line on top of the local Home pointing at the team wiki. A body edited meanwhile is left alone. */
async function writeBanner(opened: OpenedWiki, homeId: string, link: string): Promise<boolean> {
  const { markdown, version } = await opened.wiki.readBody(homeId);
  if (markdown.startsWith(MIGRATION_BANNER_PREFIX)) return true;
  const result = await opened.wiki.writeBody(homeId, `${migrationBanner(link)}\n\n${markdown}`, version);
  return result.ok;
}
