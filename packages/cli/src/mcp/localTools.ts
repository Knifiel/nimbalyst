/**
 * Shared plumbing for the local wiki tools: definitions from the shared
 * contract, the wiki each call opens, and how failures become results.
 */
import { LocalWikiError } from '@nimbalyst/local-wiki';
import { pageToolContract, type PageToolName } from '@nimbalyst/collab-protocol';
import { CliError, usageError } from '../cli/exitCodes.js';
import type { WikiLocation, Workspace } from '../localWiki/locate.js';
import { NoLocalWikiError, type InitResult, type OpenedWiki } from '../localWiki/open.js';
import { isTeamIssueKey, isTeamReference } from '../localWiki/tree.js';
import { TeamScopeRefusal, textResult, type McpTool, type McpToolDefinition, type McpToolResult } from './toolMap.js';

export interface LocalWikiContext {
  /** Opens (or re-scans) the wiki for one call; throws NoLocalWikiError when there is none. */
  open(): Promise<OpenedWiki>;
  /** Creates the wiki, at `location` (relative to the project root) or the configured/default folder. */
  init(location?: string): Promise<InitResult>;
  /** The project (and location, if any) every later call resolves against. */
  workspace(): Workspace;
  /**
   * Points every later call at another project or wiki folder (relative to the
   * current project root), for the rest of the server's life. Throws, changing
   * nothing, when the folder does not exist.
   */
  use(folder: string): WikiLocation;
}

export type Args = Record<string, unknown>;

/** Local-only: the team wiki already exists on the server, so the shared contract has no create-wiki tool. */
export const INIT_TOOL_NAME = 'initLocalWiki';
/** Local-only: the team server's project comes from the repository binding, not a folder. */
export const USE_TOOL_NAME = 'useLocalWiki';

const LOCAL_SECTION = {
  type: 'string',
  enum: ['team', 'personal'],
  description: "Wiki section. Only the local wiki here ('personal' or omitted); 'team' is refused, use the nimbalyst-team server for team pages.",
};

const LOCAL_PAGE_REF = {
  type: 'string',
  description: 'The page: its uri from listPages (local-wiki://<id>), its id, or its path in the wiki folder.',
};

/**
 * Contract argument wording that is wrong on a local wiki: local typed pages
 * have ids, never issue keys, and the wiki has no sections or projects.
 */
const LOCAL_WORDING: Array<[RegExp, string]> = [
  [/ \/ issue key/g, ''],
  [/, issue key or type id/g, ' or type id'],
  [/ or issue key, or type id/g, ', or type id'],
  [/, or typed-page issue key/g, ''],
  [/top of the (?:section|project)/g, 'top of the wiki'],
];

function localWording(property: unknown): unknown {
  if (!property || typeof property !== 'object') return property;
  const { description } = property as { description?: unknown };
  if (typeof description !== 'string') return property;
  return { ...property, description: LOCAL_WORDING.reduce((text, [from, to]) => text.replace(from, to), description) };
}

/**
 * The contract's name and input schema, with the local description, `section`
 * and page-uri wording, minus arguments that mean nothing locally, plus any
 * local-only arguments.
 */
export function contractDefinition(
  name: PageToolName,
  description: string,
  options: { drop?: string[]; extra?: Record<string, unknown> } = {},
): McpToolDefinition {
  const contract = pageToolContract(name);
  if (!contract) throw new Error(`nim mcp: ${name} is not in the page tool contract`);
  const properties: Record<string, unknown> = Object.fromEntries(Object.entries(contract.inputSchema.properties).map(([key, value]) => [key, localWording(value)]));
  for (const key of options.drop ?? []) delete properties[key];
  if ('section' in properties) properties.section = LOCAL_SECTION;
  if ('filePath' in properties) properties.filePath = LOCAL_PAGE_REF;
  Object.assign(properties, options.extra);
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties,
      ...(contract.inputSchema.required ? { required: contract.inputSchema.required } : {}),
    },
    annotations: { readOnlyHint: contract.readOnly, destructiveHint: name === 'deleteSharedItem', openWorldHint: false },
  };
}

export interface TeamRefs {
  /** Arguments holding a page reference: a collab:// uri or console link there is team data. */
  refKeys?: string[];
  /** Arguments holding an item id: a team issue key (`NIM-123`) there is team data. */
  issueKeys?: string[];
}

/** Refuse a call aimed at the team wiki: `section: 'team'`, a team uri or link, or a team issue key. */
export function refuseTeamScope(name: string, args: Args, refs: TeamRefs = {}): void {
  if (args.section === 'team') throw new TeamScopeRefusal(name);
  for (const key of refs.refKeys ?? []) {
    const value = args[key];
    if (typeof value === 'string' && isTeamReference(value)) throw new TeamScopeRefusal(name);
  }
  for (const key of refs.issueKeys ?? []) {
    const value = args[key];
    if (typeof value === 'string' && isTeamIssueKey(value)) throw new TeamScopeRefusal(name);
  }
}

export const str = (args: Args, key: string): string | undefined => {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
};

export function requireStr(args: Args, key: string): string {
  const value = str(args, key);
  if (value === undefined) throw usageError(`\`${key}\` is required`);
  return value;
}

/** What a tool answers when the project has no local wiki yet. */
export function noLocalWikiResult(err: NoLocalWikiError): McpToolResult {
  return textResult(
    `No local wiki at ${err.dir}. Call \`${INIT_TOOL_NAME}\` to create one ` +
      '(default nimbalyst-local/wiki, kept out of git; pass `location` for a checked-in folder such as docs/wiki).',
    true,
  );
}

/**
 * A tool over the local wiki. Expected failures (no wiki, not found, bad
 * argument, team scope) are results the agent reads and acts on.
 */
export function localTool(
  definition: McpToolDefinition,
  context: LocalWikiContext,
  run: (opened: OpenedWiki, args: Args) => Promise<unknown>,
  teamRefs: TeamRefs = {},
): McpTool {
  return {
    definition,
    call: async (args): Promise<McpToolResult> => {
      try {
        // Before opening anything: team calls are refused whether or not a local wiki exists.
        refuseTeamScope(definition.name, args, teamRefs);
        const opened = await context.open();
        const value = await run(opened, args);
        // Every result names its wiki folder, so an agent sees which project answered.
        return textResult(value && typeof value === 'object' && !Array.isArray(value) ? { wikiFolder: opened.dir, ...value } : value);
      } catch (err) {
        if (err instanceof NoLocalWikiError) return noLocalWikiResult(err);
        if (err instanceof TeamScopeRefusal) return textResult(err.message, true);
        if (err instanceof LocalWikiError || err instanceof CliError) {
          return textResult(`${definition.name}: ${err.message}`, true);
        }
        throw err;
      }
    },
  };
}
