/**
 * `nim mcp` — serve local wiki tools to an agent over stdio. See mcp/stdioServer.ts.
 */
import type { ParsedArgs } from '../cli/parse.js';
import { flagStr } from '../cli/parse.js';
import { runStdioServer } from '../mcp/stdioServer.js';
import { createLocalToolMap, localWikiContext } from '../mcp/serverTools.js';
import { serveTool } from '../mcp/serveTool.js';
import { editorModelsFromWikiWeb, editorTools } from '../mcp/editorTools.js';
import { teamTools } from '../mcp/teamTools.js';

export async function runMcp(version: string, args: ParsedArgs, takeNotice?: () => string | null): Promise<number> {
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
  const serve = serveTool({ startDir, location, assetsDir, version });
  const editors = editorTools(context, editorModelsFromWikiWeb({ assetsDir, version }));
  process.stderr.write(`nim mcp ${version}: serving on stdio\n`);
  await runStdioServer({ tools: createLocalToolMap(context, [...editors, serve, ...teamTools(context)]), serverInfo: { name: 'nimbalyst-local', version }, takeNotice });
  // A browser server left listening would keep this process alive after the agent hangs up.
  await serve.close();
  return 0;
}
