/**
 * Worktree groups: one task folder (the anchor, a worktree of the project's
 * repository) holding worktrees of other repositories at their own paths
 * inside it (the members). See `Worktree.groupId`.
 *
 * Everything that decides whether a group may be archived reads the whole
 * group, not the anchor: the archive dialog skips itself for a worktree that
 * is clean and merged, and an anchor alone can be both while a member holds
 * the only copy of someone's work.
 */

import type { WorktreeStatus } from './GitWorktreeService';
import type { Worktree } from './WorktreeStore';

export interface GroupMemberStatus {
  worktreeId: string;
  path: string;
  /** The repository the member was branched from */
  repoPath: string;
  /** Null when git could not report on the member */
  status: WorktreeStatus | null;
}

export type GroupWorktreeStatus = WorktreeStatus & { members: GroupMemberStatus[] };

/**
 * An anchor's status with its members folded in: uncommitted anywhere is
 * uncommitted, merged only when everything is merged. A member git could not
 * read counts as dirty and unmerged, so nothing treats it as safe to remove.
 */
export function combineGroupStatus(anchor: WorktreeStatus, members: GroupMemberStatus[]): GroupWorktreeStatus {
  let combined: WorktreeStatus = { ...anchor };
  for (const { status } of members) {
    if (!status) {
      combined = { ...combined, hasUncommittedChanges: true, isMerged: false };
      continue;
    }
    combined = {
      hasUncommittedChanges: combined.hasUncommittedChanges || status.hasUncommittedChanges,
      modifiedFileCount: combined.modifiedFileCount + status.modifiedFileCount,
      commitsAhead: combined.commitsAhead + status.commitsAhead,
      commitsBehind: combined.commitsBehind + status.commitsBehind,
      isMerged: combined.isMerged && status.isMerged,
      uniqueCommitsAhead: (combined.uniqueCommitsAhead ?? combined.commitsAhead)
        + (status.uniqueCommitsAhead ?? status.commitsAhead),
    };
  }
  return { ...combined, members };
}

/** Why a group member is refused when a caller archives or deletes it directly */
export function groupMemberRefusal(worktree: Pick<Worktree, 'id' | 'path' | 'groupId'>): string {
  return `${worktree.path} is part of a worktree group; archive or delete the group's task folder instead.`;
}
