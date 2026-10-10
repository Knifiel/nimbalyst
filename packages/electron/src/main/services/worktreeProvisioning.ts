/**
 * Creates a worktree the way the project is set up for it: a group with the
 * repositories cloned in the project when that is the choice, then the
 * project's setup step (copied files, setup command in a terminal). The New
 * Worktree dialog and agent-spawned sessions both create worktrees through
 * here, so an agent's worktree matches the one the user would have made.
 */
import { BrowserWindow } from 'electron';
import log from 'electron-log/main';
import { GitWorktreeService } from './GitWorktreeService';
import { createWorktreeStore, type Worktree } from './WorktreeStore';
import { createWorktreeGroup } from './worktreeGroupCreate';
import { listWorkspaceRepos } from './workspaceRepos';
import { resolveWorktreesDir } from './worktreeLocation';
import {
  copyWorktreeSetupFiles,
  normalizeWorktreeSetup,
  planWorktreeSetupCopies,
  worktreeSetupEnv,
  type WorktreeSetupLayout,
} from './worktreeSetup';
import { getDatabase } from '../database/initialize';
import { gitRefWatcher } from '../file/GitRefWatcher';
import { isGitRepositoryInUse } from '../file/GitWatcherLifecycle';
import { createWorkspaceTerminal } from '../ipc/TerminalHandlers';
import { getWorkspaceRoots, getWorkspaceState } from '../utils/store';
import { relativeInside, resolveAgentWorktreeRepos, type AgentWorktreeProvisioner } from './agentWorktreeRepos';
import { getTerminalSessionManager } from './TerminalSessionManager';

export { relativeInside, resolveAgentWorktreeRepos } from './agentWorktreeRepos';

const logger = log.scope('WorktreeProvisioning');

/** Tell every window its terminal list changed. */
export function emitTerminalListChanged(workspacePath: string): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('terminal:list-changed', { workspacePath });
    }
  }
}

/**
 * The project's setup step for a new worktree: configured files copied in,
 * then the configured command run in a terminal of the worktree. Never fails
 * the creation; problems are logged. Returns the setup terminal, if one opened.
 */
export async function runWorktreeSetup(input: {
  workspacePath: string;
  worktree: Pick<Worktree, 'id' | 'path' | 'name' | 'branch'>;
  layout: WorktreeSetupLayout;
}): Promise<{ setupTerminalId?: string }> {
  const { workspacePath, worktree, layout } = input;
  try {
    const setup = normalizeWorktreeSetup(getWorkspaceState(workspacePath).worktreeSetup);
    if (setup.copy.length === 0 && !setup.command) return {};
    const nestedClones = (await listWorkspaceRepos(workspacePath))
      .map(repo => relativeInside(workspacePath, repo))
      .filter((relative): relative is string => relative !== null);
    const plan = planWorktreeSetupCopies({
      projectPath: workspacePath,
      taskRoot: worktree.path,
      layout,
      nestedClones,
      copy: setup.copy,
    });
    // The command still runs when copying fails: an install does not need every file
    try {
      const copied = copyWorktreeSetupFiles(workspacePath, plan);
      logger.info('Worktree setup copied files', { worktreeId: worktree.id, copied: copied.length, skipped: plan.skipped.length });
    } catch (copyError) {
      logger.error('Worktree setup could not copy files', { worktreeId: worktree.id, error: copyError });
    }
    if (!setup.command) return {};
    const result = await createWorkspaceTerminal({
      workspacePath,
      cwd: worktree.path,
      worktreeId: worktree.id,
      title: 'Worktree setup',
      source: 'worktree',
      env: worktreeSetupEnv({
        worktreePath: worktree.path,
        name: worktree.name,
        branch: worktree.branch,
        projectPath: workspacePath,
        groupMembers: layout.kind === 'project' ? layout.members : [],
      }),
      initialCommand: setup.command,
    });
    if (!result.success) {
      logger.warn('Worktree setup could not open its terminal', { worktreeId: worktree.id, error: result.error });
      return {};
    }
    emitTerminalListChanged(workspacePath);
    return { setupTerminalId: result.terminalId };
  } catch (error) {
    logger.error('Worktree setup failed', { worktreeId: worktree.id, error });
    return {};
  }
}

/**
 * Create a worktree of the project, as a group when `members` (clones of the
 * project) are given, record it, and start its setup step.
 */
export async function createConfiguredWorktree(input: {
  workspacePath: string;
  name: string;
  members: readonly string[];
  /** Identity GitRefWatcher routes the worktree's ref events to. */
  refWatcherWorkspace: string;
}): Promise<{ worktree: Worktree; setupTerminalId?: string }> {
  const { workspacePath, name, members, refWatcherWorkspace } = input;
  const db = getDatabase();
  if (!db) throw new Error('Database not initialized');
  const store = createWorktreeStore(db);
  const service = new GitWorktreeService();

  let anchor: Worktree;
  let checkouts: Worktree[];
  let layout: WorktreeSetupLayout;
  if (members.length > 0) {
    const created = await createWorktreeGroup(workspacePath, {
      name,
      nameSource: 'suggested',
      members: members.map(repoPath => ({ repoPath })),
    }, {
      service,
      store,
      knownRepos: await listWorkspaceRepos(workspacePath),
      worktreesDir: resolveWorktreesDir(workspacePath, getWorkspaceRoots(workspacePath)),
    });
    anchor = created.anchor;
    checkouts = [created.anchor, ...created.members];
    layout = {
      kind: 'project',
      members: created.members.map(member => relativeInside(workspacePath, member.sourceFolderPath ?? member.path) ?? ''),
    };
  } else {
    anchor = await service.createWorktree(workspacePath, { name });
    await store.create(anchor);
    checkouts = [anchor];
    layout = { kind: 'project', members: [] };
  }

  for (const checkout of checkouts) {
    if (isGitRepositoryInUse(checkout.path, new Set([workspacePath]))) {
      gitRefWatcher.start(checkout.path, undefined, refWatcherWorkspace).catch((error: Error) => {
        logger.error('Failed to start GitRefWatcher for a new worktree checkout:', error);
      });
    }
  }

  const { setupTerminalId } = await runWorktreeSetup({ workspacePath, worktree: anchor, layout });
  return { worktree: anchor, setupTerminalId };
}

/** What agent-spawned sessions create worktrees through (wired in index.ts). */
export const agentWorktreeProvisioner: AgentWorktreeProvisioner = {
  async create({ workspacePath, name, repos, refWatcherWorkspace }) {
    const members = resolveAgentWorktreeRepos({
      workspacePath,
      knownRepos: await listWorkspaceRepos(workspacePath),
      requested: repos,
      remembered: getWorkspaceState(workspacePath).worktreeRepoSelection,
    });
    return createConfiguredWorktree({ workspacePath, name, members, refWatcherWorkspace });
  },
  waitForSetup: (setupTerminalId) => getTerminalSessionManager().waitForCommandToFinish(setupTerminalId),
};
