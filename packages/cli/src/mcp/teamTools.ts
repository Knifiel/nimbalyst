/**
 * The local server's Teams tools, for a Claude Code user with no desktop app:
 *
 * - `teamSignIn`: the `nim login` device flow, from inside the MCP server. The
 *   tokens land where `nim login` keeps them, so both share one sign-in. A tool
 *   call cannot wait the many minutes an approval may take, so the first call
 *   starts the flow, opens the approval page and answers `pending`; later calls
 *   wait a little and answer `signedIn` once it is approved.
 * - `moveLocalWikiToTeam`: the whole local wiki into the bound team project
 *   (localWiki/moveToTeam.ts). Page bodies go from the files to the server;
 *   the agent gets counts, links and errors.
 * - `openUrl`: opens a Nimbalyst console page in the user's browser, and
 *   nothing else.
 */
import { CliError, usageError } from '../cli/exitCodes.js';
import { fetchUserInfo, nimbalystDeviceLogin, type UserInfo } from '../cloud/auth.js';
import { resolveServer } from '../cloud/config.js';
import { loadCredentials } from '../cloud/credentials.js';
import { NoLocalWikiError } from '../localWiki/open.js';
import { moveLocalWikiToTeam, MoveRefusal, type MoveDeps } from '../localWiki/moveToTeam.js';
import { openBrowser } from '../serve/runWikiServe.js';
import { noLocalWikiResult, type LocalWikiContext } from './localTools.js';
import { textResult, type McpTool } from './toolMap.js';

export const SIGN_IN_TOOL_NAME = 'teamSignIn';
export const MOVE_TOOL_NAME = 'moveLocalWikiToTeam';
export const OPEN_URL_TOOL_NAME = 'openUrl';

export const CONSOLE_ORIGIN = 'https://console.nimbalyst.com';

/**
 * Only the console's own pages. On Windows the opener goes through `cmd`, so
 * characters cmd treats specially are refused even inside a console URL.
 */
export function checkConsoleUrl(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw usageError('`url` is required');
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw usageError(`Not a URL: ${raw}`);
  }
  if (url.origin !== CONSOLE_ORIGIN || url.username || url.password) {
    throw usageError(`openUrl only opens Nimbalyst console pages (${CONSOLE_ORIGIN}/...). Give the user this link instead: ${raw}`);
  }
  if (/[\s"&<>^|%]/.test(url.href.replace(/%[0-9A-Fa-f]{2}/g, ''))) {
    throw usageError(`openUrl refuses this URL's characters. Give the user the link instead: ${raw}`);
  }
  return url.href;
}

interface SignInPrompt {
  userCode: string;
  verificationUrl: string;
}

export interface TeamToolOptions {
  /** Tests replace the browser, the device flow and identity lookup. */
  openUrl?: (url: string) => void;
  deviceLogin?: typeof nimbalystDeviceLogin;
  userInfo?: (server: string) => Promise<UserInfo | undefined>;
  /** How long a follow-up `teamSignIn` call waits for approval before answering pending. */
  pollWaitMs?: number;
  moveDeps?: MoveDeps;
}

function signInTool(options: TeamToolOptions): McpTool {
  const open = options.openUrl ?? openBrowser;
  const deviceLogin = options.deviceLogin ?? nimbalystDeviceLogin;
  const userInfo = options.userInfo ?? fetchUserInfo;
  const pollWaitMs = options.pollWaitMs ?? 20_000;
  let flow: { server: string; prompt: SignInPrompt; done: Promise<void>; error?: Error; finished: boolean } | null = null;

  const signedIn = async (server: string) => {
    const info = await userInfo(server).catch(() => undefined);
    return textResult({ state: 'signedIn', server, ...(info?.email ? { email: info.email } : {}) });
  };

  const pending = (prompt: SignInPrompt) =>
    textResult({
      state: 'pending',
      verificationUrl: prompt.verificationUrl,
      userCode: prompt.userCode,
      next:
        'The approval page is open in the browser. Ask the user to confirm the code there and approve, then call teamSignIn again to finish. ' +
        'If no browser opened, give the user verificationUrl.',
    });

  const start = async (server: string) => {
    let resolvePrompt!: (prompt: SignInPrompt) => void;
    const prompted = new Promise<SignInPrompt>((resolve) => (resolvePrompt = resolve));
    const login = deviceLogin(server, (userCode, uri, completeUri) => {
      const verificationUrl = String(completeUri ?? uri);
      resolvePrompt({ userCode: String(userCode), verificationUrl });
      if (/^https:\/\//i.test(verificationUrl)) open(verificationUrl);
    });
    const current = { server, prompt: { userCode: '', verificationUrl: '' }, finished: false } as NonNullable<typeof flow>;
    current.done = login.then(
      () => {
        current.finished = true;
      },
      (err: Error) => {
        current.finished = true;
        current.error = err;
      },
    );
    flow = current;
    // Whichever comes first: the code to show, or a flow that failed before giving one.
    const first = await Promise.race([prompted, current.done.then(() => null)]);
    if (first) current.prompt = first;
    return current;
  };

  return {
    definition: {
      name: SIGN_IN_TOOL_NAME,
      description:
        "Sign this machine's local wiki server in to Nimbalyst Teams, so moveLocalWikiToTeam can write to the team project. " +
        'This is a separate approval from the nimbalyst-team server\'s /mcp sign-in; it is the same sign-in `nim login` uses. ' +
        'The first call opens the approval page in the browser and returns state pending with the code the page shows; ask the user to approve, then call again. ' +
        'Returns state signedIn (with the email) once approved, or right away when already signed in. Pass restart: true to start over with a new code.',
      inputSchema: {
        type: 'object',
        properties: { restart: { type: 'boolean', description: 'Discard a pending sign-in and start a new one.' } },
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    call: async (args) => {
      try {
        const server = resolveServer();
        if (args.restart === true) flow = null;
        if (!flow && loadCredentials(server)) {
          // A stored session that still works needs no new approval.
          const info = await userInfo(server).catch((err) => (err instanceof CliError ? null : Promise.reject(err)));
          if (info !== null) return textResult({ state: 'signedIn', server, ...(info?.email ? { email: info.email } : {}) });
        }
        if (!flow || flow.server !== server) {
          const started = await start(server);
          if (started.error) {
            flow = null;
            return textResult(`${SIGN_IN_TOOL_NAME}: ${started.error.message}`, true);
          }
          if (!started.finished) return pending(started.prompt);
        }
        const current = flow!;
        if (!current.finished) {
          await Promise.race([current.done, new Promise((resolve) => setTimeout(resolve, pollWaitMs))]);
        }
        if (!current.finished) return pending(current.prompt);
        flow = null;
        if (current.error) return textResult(`${SIGN_IN_TOOL_NAME}: ${current.error.message} Call teamSignIn again for a new code.`, true);
        return signedIn(server);
      } catch (err) {
        return textResult(`${SIGN_IN_TOOL_NAME}: ${(err as Error).message}`, true);
      }
    },
  };
}

function moveTool(context: LocalWikiContext, options: TeamToolOptions): McpTool {
  return {
    definition: {
      name: MOVE_TOOL_NAME,
      description:
        "Move this project's whole local wiki into the team project this repository is bound to: pages, hierarchy, order, typed pages, their types and fields, with links between pages rewritten to the team pages. " +
        'Needs teamSignIn first and a bound repository (pages_status on nimbalyst-team says bound). Run with dryRun: true first and show the user the counts. ' +
        'Page text goes straight from the files to the server and is not returned; the result has counts, the Home link, and any errors. ' +
        'The local files are never deleted. After a verified import the local wiki is marked as moved (migratedTo in .nimbalyst/local-wiki.json) and its Home gets a line pointing at the team wiki. ' +
        'Safe to run again: an interrupted move resumes and updates instead of duplicating.',
      inputSchema: {
        type: 'object',
        properties: {
          project: {
            type: 'object',
            description: 'The team project, { orgId, projectId }, when the repository resolves to several. Default: .nimbalyst/wiki.json, else the repository binding.',
            properties: { orgId: { type: 'string' }, projectId: { type: 'string' } },
            required: ['orgId', 'projectId'],
          },
          dryRun: { type: 'boolean', description: 'Count what would move and check the target project; send nothing.' },
        },
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    call: async (args) => {
      try {
        const project = args.project as { orgId?: unknown; projectId?: unknown } | undefined;
        const pin =
          project && typeof project.orgId === 'string' && typeof project.projectId === 'string'
            ? { orgId: project.orgId, projectId: project.projectId }
            : undefined;
        const opened = await context.open();
        const report = await moveLocalWikiToTeam(opened, { project: pin, dryRun: args.dryRun === true }, options.moveDeps);
        return textResult({ wikiFolder: opened.dir, ...report }, report.verified === false);
      } catch (err) {
        if (err instanceof NoLocalWikiError) return noLocalWikiResult(err);
        if (err instanceof MoveRefusal) return textResult({ error: err.message, ...(err.next ? { next: err.next } : {}) }, true);
        return textResult(`${MOVE_TOOL_NAME}: ${(err as Error).message}`, true);
      }
    },
  };
}

function openUrlTool(options: TeamToolOptions): McpTool {
  const open = options.openUrl ?? openBrowser;
  return {
    definition: {
      name: OPEN_URL_TOOL_NAME,
      description:
        `Open a Nimbalyst console page (${CONSOLE_ORIGIN}/...) in the user's web browser, such as the homeLink a team tool returned. ` +
        'Any other URL is refused; give it to the user instead.',
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string', description: `A ${CONSOLE_ORIGIN}/... link.` } },
        required: ['url'],
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    call: async (args) => {
      try {
        const url = checkConsoleUrl(args.url);
        open(url);
        return textResult({ opened: true, url });
      } catch (err) {
        return textResult(`${OPEN_URL_TOOL_NAME}: ${(err as Error).message}`, true);
      }
    },
  };
}

export function teamTools(context: LocalWikiContext, options: TeamToolOptions = {}): McpTool[] {
  return [signInTool(options), moveTool(context, options), openUrlTool(options)];
}
