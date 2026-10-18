/**
 * `openWikiInBrowser`: `nim wiki serve` from inside the MCP server, so a plugin
 * user reads and edits the local wiki in a browser without installing `nim`.
 * The server lives as long as the MCP server does; a second call reuses it.
 */
import { CliError } from '../cli/exitCodes.js';
import { resolveWikiLocation, type Workspace } from '../localWiki/locate.js';
import { NoLocalWikiError, openLocalWiki } from '../localWiki/open.js';
import { installHint, resolveWikiWebAssets } from '../serve/assets.js';
import { openBrowser } from '../serve/runWikiServe.js';
import type { WikiServer } from '../serve/server.js';
import { defaultSessionStore, startRememberedWikiServer } from '../serve/session.js';
import { noLocalWikiResult, refuseTeamScope } from './localTools.js';
import { textResult, TeamScopeRefusal, type McpTool } from './toolMap.js';

export const SERVE_TOOL_NAME = 'openWikiInBrowser';

export interface ServeToolOptions {
  startDir: string;
  location?: string;
  /** The current project, when the server can be re-pointed (useLocalWiki); wins over startDir/location. */
  workspace?: () => Workspace;
  /** Built wiki-web folder; the plugin ships one. Otherwise an installed `@nimbalyst/wiki-web` is looked up. */
  assetsDir?: string;
  version: string;
  /** Tests skip launching a browser. */
  openUrl?: (url: string) => void;
}

export interface ServeTool extends McpTool {
  /** Stops the browser server, if one was started. */
  close(): Promise<void>;
}

export function serveTool(options: ServeToolOptions): ServeTool {
  const openUrl = options.openUrl ?? openBrowser;
  let running: { server: WikiServer; dir: string; closeWiki: () => void } | null = null;
  const close = async () => {
    if (!running) return;
    const { server, closeWiki } = running;
    running = null;
    await server.close();
    closeWiki();
  };

  return {
    definition: {
      name: SERVE_TOOL_NAME,
      description:
        "Open this project's local wiki in the user's web browser to read and edit: the page tree, rich page editing, typed pages and type tables. " +
        'Edits save straight to the wiki files, and changes agents make show up live. ' +
        'Starts a server on this machine only (token in the URL) that runs until this session ends; calling again reuses it. ' +
        'Returns the URL; give it to the user. Pass open: false to only return the URL.',
      inputSchema: {
        type: 'object',
        properties: {
          open: { type: 'boolean', description: 'Open the browser. Default true.' },
        },
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    call: async (args) => {
      try {
        refuseTeamScope(SERVE_TOOL_NAME, args);
        const { startDir, location } = options.workspace?.() ?? options;
        // After useLocalWiki, a browser server on the old project's wiki gives way to one on the new.
        if (running && running.dir !== resolveWikiLocation(startDir, location).dir) await close();
        if (!running) {
          const opened = await openLocalWiki(startDir, location);
          const resolution = resolveWikiWebAssets({ flag: options.assetsDir, projectRoot: opened.projectRoot });
          if (!resolution.ok) {
            opened.wiki.close();
            return textResult(installHint(options.version, resolution), true);
          }
          const server = await startRememberedWikiServer(
            { wiki: opened.wiki, assetsDir: resolution.assets.dir, version: options.version, projectRoot: opened.projectRoot },
            defaultSessionStore(opened.wiki.root),
          );
          running = { server, dir: opened.dir, closeWiki: () => opened.wiki.close() };
        }
        if (args.open !== false) openUrl(running.server.url);
        return textResult({ url: running.server.url, wiki: running.dir });
      } catch (err) {
        if (err instanceof NoLocalWikiError) return noLocalWikiResult(err);
        if (err instanceof TeamScopeRefusal) return textResult(err.message, true);
        if (err instanceof CliError) return textResult(err.message, true);
        return textResult(`${SERVE_TOOL_NAME}: ${(err as Error).message}`, true);
      }
    },
    close,
  };
}
