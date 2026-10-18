import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { getSessionCommitCheckout, revalidateProposalWorktree } from '../gitCommitProposalTarget';
import { loadGitCommitProposalRecord } from './gitCommitProposalPromptUtils';

/** Written on every proposal record whose `workspacePath` is the validated session checkout. */
export const COMMIT_TARGET_VERSION = 2;

const PROPOSE_AGAIN =
  'Ask the agent to propose the commit again.';

function canonical(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

/**
 * #1756 / #1529: a proposal commits where main validated it when the proposal
 * was created, as stored on its durable record. Paths the caller supplies are
 * ignored. A sibling-worktree target is checked again right before the commit,
 * since the worktree may have moved since. Records from older builds stored
 * the parent workspace while the widget committed in the session's worktree,
 * so they are refused rather than guessed at.
 */
export async function resolveProposalCommitPaths(
  sessionId: string,
  proposalId: string,
): Promise<{ workspacePath: string; repoPath?: string }> {
  const record = await loadGitCommitProposalRecord(sessionId, proposalId);
  if (!record || typeof record.workspacePath !== 'string' || !record.workspacePath) {
    throw new Error('Cannot find where this commit proposal commits. Refresh the session before answering.');
  }
  const worktreePath = record.targetWorktree?.path;
  if (typeof worktreePath === 'string') {
    await revalidateProposalWorktree(sessionId, worktreePath);
    return { workspacePath: worktreePath, repoPath: worktreePath };
  }
  if (record.commitTargetVersion !== COMMIT_TARGET_VERSION) {
    throw new Error(`This commit proposal is from an older version of Nimbalyst and does not record where it commits. ${PROPOSE_AGAIN}`);
  }
  if (canonical(record.workspacePath) !== canonical(await getSessionCommitCheckout(sessionId))) {
    throw new Error(`This commit proposal no longer matches the session's checkout. ${PROPOSE_AGAIN}`);
  }
  return {
    workspacePath: record.workspacePath,
    ...(typeof record.repoPath === 'string' && record.repoPath ? { repoPath: record.repoPath } : {}),
  };
}
