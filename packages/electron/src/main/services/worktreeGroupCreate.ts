/**
 * Creating a worktree group: one task folder (the anchor, a worktree of the
 * project's repository) with a worktree of each chosen nested clone at that
 * clone's own path inside it, all on one branch name.
 *
 * Everything that can be checked without writing is checked in every
 * repository first, so a conflict in the last member creates nothing. After
 * that, a failure removes what this call created -- and only that: a member
 * goes in at an exact path that must be empty, so there is never someone
 * else's folder to roll back over.
 */

import * as path from 'path';
import log from 'electron-log/main';
import type { CreateWorktreeOptions, DeleteWorktreeOptions, Worktree as GitWorktree } from './GitWorktreeService';
import type { Worktree, WorktreeStore } from './WorktreeStore';
import {
  buildWorktreeBranchName,
  stripWorktreeBranchPrefix,
  validateWorktreeBranchSuffix,
  type WorktreeNameSource,
} from '../../shared/worktreeBranchNaming';

const logger = log.scope('worktreeGroupCreate');

export interface WorktreeGroupMemberRequest {
  /** A nested clone of the project, as `listWorkspaceRepos` reports it */
  repoPath: string;
  /** Defaults to the clone's current branch */
  baseBranch?: string;
}

export interface CreateWorktreeGroupRequest {
  name?: string;
  nameSource?: WorktreeNameSource;
  /** Base of the anchor; defaults to the project repository's current branch */
  anchorBaseBranch?: string;
  members: WorktreeGroupMemberRequest[];
}

export interface WorktreeGroupCreateDeps {
  service: {
    createWorktree(repoPath: string, options: CreateWorktreeOptions): Promise<GitWorktree>;
    deleteWorktree(worktreePath: string, repoPath: string, options: DeleteWorktreeOptions): Promise<void>;
    assertBranchAvailable(repoPath: string, branchName: string): Promise<void>;
    assertCommitRef(repoPath: string, ref: string): Promise<void>;
    readCurrentBranch(repoPath: string): Promise<string>;
    findTrackedPath(repoPath: string, refs: readonly string[], paths: readonly string[]): Promise<{ ref: string; path: string } | null>;
    isIgnoredDirectory(checkoutPath: string, relativeDir: string): Promise<boolean>;
    getAllBranchNames(repoPath: string): Promise<Set<string>>;
    getExistingWorktreeDirectories(repoPath: string, worktreesDir?: string): Set<string>;
    generateUniqueWorktreeName(existingNames: Set<string>): string;
  };
  store: Pick<WorktreeStore, 'create' | 'delete' | 'getAllNames' | 'getAllPaths'>;
  /** The project's repositories (`listWorkspaceRepos`); members must be among them */
  knownRepos: readonly string[];
  /** Where the anchor goes (`resolveWorktreesDir`) */
  worktreesDir: string;
}

/** A member's folder relative to the project root; throws unless it is a clone strictly inside it */
export function memberRelativePath(projectPath: string, repoPath: string, knownRepos: readonly string[]): string {
  const relative = path.relative(path.resolve(projectPath), path.resolve(repoPath));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${repoPath} is not a repository inside ${projectPath}`);
  }
  if (!knownRepos.some(known => path.resolve(known) === path.resolve(repoPath))) {
    throw new Error(`${repoPath} is not one of this project's repositories`);
  }
  return relative.split(path.sep).join('/');
}

/**
 * Creates the group and its rows, returning them. On failure,
 * removes what it created and rethrows; when that removal fails too, the
 * error names every path left behind.
 */
export async function createWorktreeGroup(
  projectPath: string,
  request: CreateWorktreeGroupRequest,
  deps: WorktreeGroupCreateDeps
): Promise<{ anchor: Worktree; members: Worktree[] }> {
  const { service, store } = deps;
  if (request.members.length === 0) {
    throw new Error('A worktree group needs at least one member repository');
  }

  // 1. Validate the request
  const members = request.members.map(member => ({
    ...member,
    relativePath: memberRelativePath(projectPath, member.repoPath, deps.knownRepos),
  }));
  if (new Set(members.map(member => member.relativePath)).size !== members.length) {
    throw new Error('A worktree group names the same repository twice');
  }
  const typedSuffix = request.nameSource === 'user' && request.name ? request.name : undefined;
  if (typedSuffix !== undefined) {
    const problem = validateWorktreeBranchSuffix(typedSuffix);
    if (problem) throw new Error(`Invalid worktree name '${typedSuffix}': ${problem.message}`);
  }

  // 2. Read-only preflight, in every repository
  const anchorBase = request.anchorBaseBranch ?? await service.readCurrentBranch(projectPath);
  await service.assertCommitRef(projectPath, anchorBase);
  const memberBases = await Promise.all(members.map(async member => {
    const base = member.baseBranch ?? await service.readCurrentBranch(member.repoPath);
    await service.assertCommitRef(member.repoPath, base);
    return base;
  }));
  const tracked = await service.findTrackedPath(projectPath, [anchorBase], members.map(member => member.relativePath));
  if (tracked) {
    throw new Error(
      `${tracked.ref} tracks ${tracked.path}, where a member checkout would go, so the group was not created.`
    );
  }
  let name = request.name;
  if (typedSuffix === undefined && !name) {
    const taken = new Set<string>([
      ...await store.getAllNames(),
      ...service.getExistingWorktreeDirectories(projectPath, deps.worktreesDir),
    ]);
    for (const repo of [projectPath, ...members.map(member => member.repoPath)]) {
      for (const branch of await service.getAllBranchNames(repo)) taken.add(branch);
    }
    name = service.generateUniqueWorktreeName(taken);
  }
  const plannedBranch = buildWorktreeBranchName(typedSuffix ?? name!);
  for (const repo of [projectPath, ...members.map(member => member.repoPath)]) {
    await service.assertBranchAvailable(repo, plannedBranch);
  }

  // 3. Create: the anchor, then each member at its exact path inside it
  const created: Array<{ worktree: GitWorktree; repoPath: string }> = [];
  const rows: string[] = [];
  try {
    const takenPaths = await store.getAllPaths();
    const anchor = await service.createWorktree(projectPath, {
      ...(typedSuffix !== undefined ? { branchSuffix: typedSuffix } : { name }),
      baseBranch: anchorBase,
      takenPaths,
      worktreesDir: deps.worktreesDir,
    });
    created.push({ worktree: anchor, repoPath: projectPath });

    for (const member of members) {
      if (!await service.isIgnoredDirectory(anchor.path, member.relativePath)) {
        throw new Error(
          `The project does not ignore ${member.relativePath}/, so a member checkout there would show up as ` +
          'untracked files in the task folder; the group was not created.'
        );
      }
    }

    // Every member takes the anchor's branch name, exactly
    const branchSuffix = stripWorktreeBranchPrefix(anchor.branch);
    const memberWorktrees: GitWorktree[] = [];
    for (const [index, member] of members.entries()) {
      const worktree = await service.createWorktree(member.repoPath, {
        branchSuffix,
        baseBranch: memberBases[index],
        exactPath: path.join(anchor.path, member.relativePath),
      });
      created.push({ worktree, repoPath: member.repoPath });
      memberWorktrees.push(worktree);
    }

    // 4. Rows: the anchor first, so a member row never points at nothing
    const anchorRow: Worktree = { ...anchor, projectPath, sourceFolderPath: projectPath, groupId: anchor.id };
    await store.create(anchorRow);
    rows.push(anchor.id);
    const memberRows: Worktree[] = [];
    for (const [index, worktree] of memberWorktrees.entries()) {
      const memberRow: Worktree = { ...worktree, projectPath, sourceFolderPath: members[index].repoPath, groupId: anchor.id };
      await store.create(memberRow);
      rows.push(worktree.id);
      memberRows.push(memberRow);
    }

    logger.info('Created worktree group', {
      anchor: anchor.path,
      members: memberWorktrees.map(worktree => worktree.path),
      branch: anchor.branch,
    });
    return { anchor: anchorRow, members: memberRows };
  } catch (error) {
    // 5. Undo in reverse, removing only what this call created
    const leftBehind: string[] = [];
    for (const id of [...rows].reverse()) {
      try {
        await store.delete(id);
      } catch (rowError) {
        logger.error('Failed to remove a worktree group row during rollback', { id, error: rowError });
      }
    }
    for (const { worktree, repoPath } of [...created].reverse()) {
      try {
        await service.deleteWorktree(worktree.path, repoPath, { expectedBranch: worktree.branch });
      } catch (removeError) {
        logger.error('Failed to remove a worktree during group rollback', { path: worktree.path, error: removeError });
        leftBehind.push(worktree.path);
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      leftBehind.length > 0
        ? `${message}\nThese checkouts could not be removed and are still on disk: ${leftBehind.join(', ')}`
        : message
    );
  }
}
