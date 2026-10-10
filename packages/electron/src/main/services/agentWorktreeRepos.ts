/**
 * Which of a project's cloned repositories a new worktree holds when an agent
 * creates it. Pure, so the choice is testable without git or Electron.
 */
import path from 'node:path';

/** `child` relative to `parent` with forward slashes, or null when it is not strictly inside. */
export function relativeInside(parent: string, child: string): string | null {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? relative.split(path.sep).join('/')
    : null;
}

/**
 * Which of the project's cloned repositories an agent-created worktree holds.
 *
 * `requested` (the agent named them) wins; each entry is a path relative to
 * the project or a folder name, and must be one of the project's clones.
 * Otherwise the user's last choice in the New Worktree dialog applies when it
 * was a group (the project plus clones). Anything else means no clones: a
 * worktree of the project repository alone, as before.
 */
export function resolveAgentWorktreeRepos(input: {
  workspacePath: string;
  knownRepos: readonly string[];
  requested?: readonly string[];
  remembered?: readonly string[];
}): string[] {
  const clones = input.knownRepos
    .map(repo => ({ repo, relative: relativeInside(input.workspacePath, repo) }))
    .filter((clone): clone is { repo: string; relative: string } => clone.relative !== null);

  if (input.requested) {
    const picked: string[] = [];
    for (const entry of input.requested) {
      const wanted = entry.trim().replace(/^\.\//, '').replace(/\/+$/, '');
      const byPath = clones.find(clone => clone.relative === wanted);
      const byName = clones.filter(clone => path.posix.basename(clone.relative) === wanted);
      const match = byPath ?? (byName.length === 1 ? byName[0] : undefined);
      if (!match) {
        const available = clones.map(clone => clone.relative).join(', ') || 'none';
        throw new Error(`"${entry}" is not a repository cloned in this project. Repositories: ${available}`);
      }
      if (!picked.includes(match.repo)) picked.push(match.repo);
    }
    return picked;
  }

  const remembered = input.remembered ?? [];
  const wasGroup = remembered.some(repo => path.resolve(repo) === path.resolve(input.workspacePath));
  if (!wasGroup) return [];
  return clones
    .filter(clone => remembered.some(repo => path.resolve(repo) === path.resolve(clone.repo)))
    .map(clone => clone.repo);
}

/**
 * Creates worktrees for agent-spawned sessions. Wired at startup (index.ts) so
 * MetaAgentService stays free of git, terminal and database imports.
 */
export interface AgentWorktreeProvisioner {
  /** The worktree the project is set up for, with its setup step started. */
  create(input: {
    workspacePath: string;
    name: string;
    /** Clones the agent named; omitted means the user's last dialog choice. */
    repos?: string[];
    refWatcherWorkspace: string;
  }): Promise<{ worktree: { id: string; path: string }; setupTerminalId?: string }>;
  /** Resolves once the setup terminal has run its command, or cannot be waited on. */
  waitForSetup(setupTerminalId: string): Promise<string>;
}
