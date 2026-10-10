/**
 * What the new-worktree dialog creates for the repositories the user ticked.
 *
 * - the project's repository alone: a worktree of it, as before;
 * - one nested clone alone: a worktree of that clone;
 * - the project's repository plus clones: a worktree group, each clone at
 *   its own path inside the task folder;
 * - several clones without the project's repository: refused, since a group
 *   needs the task folder the project's repository provides.
 */

export type WorktreeRepoPlan =
  | { kind: 'single'; sourceFolderPath: string }
  | { kind: 'group'; members: string[] }
  | { kind: 'invalid'; reason: string };

export function planWorktreeRepos(selection: readonly string[], projectRepo: string): WorktreeRepoPlan {
  const clones = selection.filter(repo => repo !== projectRepo);
  const includesProject = clones.length !== selection.length;
  if (selection.length === 0) {
    return { kind: 'invalid', reason: 'Choose a repository to branch.' };
  }
  if (clones.length === 0) {
    return { kind: 'single', sourceFolderPath: projectRepo };
  }
  if (!includesProject) {
    return clones.length === 1
      ? { kind: 'single', sourceFolderPath: clones[0] }
      : { kind: 'invalid', reason: 'To branch several repositories together, include the project repository.' };
  }
  return { kind: 'group', members: clones };
}

/** Repositories the dialog offers: the project's first, then the clones inside it */
export function worktreeRepoChoices(projectRepo: string, workspaceRepos: readonly string[]): string[] {
  if (!workspaceRepos.includes(projectRepo)) return [];
  const root = projectRepo.replace(/[\\/]+$/, '');
  const isInside = (repo: string) =>
    repo.length > root.length + 1 && repo.startsWith(root) && /[\\/]/.test(repo[root.length]);
  return [projectRepo, ...workspaceRepos.filter(isInside)];
}

/**
 * The repositories ticked when the dialog opens. A remembered group comes
 * back, minus repositories no longer offered; otherwise the dialog follows the
 * open file's repository, as it does without nested clones.
 */
export function restoreRepoSelection(saved: readonly string[] | undefined, choices: readonly string[], fallback: string): string[] {
  const kept = (saved ?? []).filter(repo => choices.includes(repo));
  return kept.length > 1 ? kept : [fallback];
}
