import path from 'node:path';

/**
 * The project the plugin's `nimbalyst-local` server works on. Claude Code names
 * it in `CLAUDE_PROJECT_DIR`. Codex starts the server in the plugin's own
 * directory (`"cwd": "."`, since it expands no variables in MCP args) and
 * forwards the project as `PWD`; `PWD` is trusted only then, because a host
 * that changes the cwd without updating `PWD` would otherwise point it at the
 * wrong directory. Anything else runs where it was started.
 */
export function resolvePluginWorkspace(env: NodeJS.ProcessEnv, cwd: string, pluginRoot: string): string {
  if (env.CLAUDE_PROJECT_DIR) return env.CLAUDE_PROJECT_DIR;
  if (env.PWD && path.resolve(cwd) === path.resolve(pluginRoot)) return env.PWD;
  return cwd;
}
