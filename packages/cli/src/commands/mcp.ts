/**
 * `nim mcp` — serve local wiki tools to an agent over stdio. See mcp/stdioServer.ts.
 */
import type { ParsedArgs } from '../cli/parse.js';
import { flagStr } from '../cli/parse.js';
import { runStdioServer } from '../mcp/stdioServer.js';
import { createLocalToolMap, LOCAL_SERVER_INSTRUCTIONS, localWikiContext } from '../mcp/serverTools.js';
import { serveTool } from '../mcp/serveTool.js';
import { editorModelsFromWikiWeb, editorTools } from '../mcp/editorTools.js';
import { teamTools } from '../mcp/teamTools.js';
import { versionsReport, type RunningInstall } from '../update/installs.js';

export interface McpRunOptions {
  /** A one-time update notice for the first successful tool result (mcp/updateCheck.ts). */
  takeNotice?: () => string | null;
  /** How this server was installed, for the `versions` section of wikiDoctor. */
  install?: RunningInstall;
  /** The file the server runs from. */
  executable?: string;
}

export async function runMcp(version: string, args: ParsedArgs, options: McpRunOptions = {}): Promise<number> {
  // stdout is the protocol channel. Anything below that logs through console
  // would corrupt it, so route those calls to stderr for the life of the server.
  const toStderr = (...parts: unknown[]) => console.error(...parts);
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  console.warn = toStderr;

  const startDir = flagStr(args, 'workspace') ?? process.cwd();
  const location = flagStr(args, 'location');
  const context = localWikiContext(startDir, location);
  const assetsDir = flagStr(args, 'assets');
  const serve = serveTool({ startDir, location, workspace: context.workspace, assetsDir, version });
  const loadEditorModels = editorModelsFromWikiWeb({ assetsDir, version });
  const editors = editorTools(context, loadEditorModels);
  const install = options.install;
  const versions = install
    ? () => versionsReport({ version, executable: options.executable ?? process.argv[1] ?? '', install, assetsDir, projectRoot: context.workspace().startDir })
    : undefined;
  process.stderr.write(`nim mcp ${version}: serving on stdio\n`);
  await runStdioServer({
    tools: createLocalToolMap(context, [...editors, serve, ...teamTools(context, { moveDeps: { loadEditorModels } })], { versions }),
    serverInfo: { name: 'nimbalyst-local', version },
    takeNotice: options.takeNotice,
    instructions: LOCAL_SERVER_INSTRUCTIONS,
  });
  // A browser server left listening would keep this process alive after the agent hangs up.
  await serve.close();
  return 0;
}
