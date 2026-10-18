// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rows: [] as Array<{ content: string }>,
  revalidate: vi.fn(async (_s: string, _p: string) => {}),
}));
vi.mock('../../../database/PGLiteDatabaseWorker', () => ({ database: { query: async () => ({ rows: mocks.rows }) } }));
vi.mock('../../gitCommitProposalTarget', () => ({
  revalidateProposalWorktree: mocks.revalidate,
  getSessionCommitCheckout: async () => '/session-worktree',
}));

import { resolveProposalCommitPaths } from '../proposalCommitTarget';

const row = (content: Record<string, unknown>) => ({ content: JSON.stringify({ type: 'git_commit_proposal', ...content }) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rows = [];
});

// Review repro: a valid ordinary proposal id plus renderer-chosen paths pointed the commit at any repo.
it('takes an ordinary proposal\'s checkout and repo from its stored record', async () => {
  mocks.rows = [
    row({ proposalId: 'p1', commitTargetVersion: 2, workspacePath: '/session-worktree', repoPath: '/attached' }),
    row({ proposalId: 'p2', commitTargetVersion: 2, workspacePath: '/elsewhere', repoPath: '/elsewhere' }),
  ];
  expect(await resolveProposalCommitPaths('s1', 'p1')).toEqual({ workspacePath: '/session-worktree', repoPath: '/attached' });
  expect(mocks.revalidate).not.toHaveBeenCalled();
});

// Re-review repro: builds before the Sept 15 checkout fix stored the PARENT workspace while
// the widget committed in the session's worktree; trusting the record moved the commit to /main.
it('refuses a legacy or mismatched record instead of guessing its checkout', async () => {
  mocks.rows = [row({ proposalId: 'legacy', workspacePath: '/main', repoPath: '/main', filesToStage: ['a.ts'] })];
  await expect(resolveProposalCommitPaths('s1', 'legacy')).rejects.toThrow(/older version.*propose the commit again/);
  mocks.rows = [row({ proposalId: 'moved', commitTargetVersion: 2, workspacePath: '/main', repoPath: '/main' })];
  await expect(resolveProposalCommitPaths('s1', 'moved')).rejects.toThrow(/propose the commit again/);
});

it('revalidates a stored worktree target right before the commit runs', async () => {
  mocks.rows = [row({ proposalId: 'p1', workspacePath: '/wt', repoPath: '/wt', targetWorktree: { path: '/wt', branch: 'feature' } })];
  expect(await resolveProposalCommitPaths('s1', 'p1')).toEqual({ workspacePath: '/wt', repoPath: '/wt' });
  expect(mocks.revalidate).toHaveBeenCalledWith('s1', '/wt');
  mocks.revalidate.mockRejectedValueOnce(new Error('/wt is not a registered git worktree'));
  await expect(resolveProposalCommitPaths('s1', 'p1')).rejects.toThrow('not a registered git worktree');
});

it('refuses a proposal whose stored record has no checkout', async () => {
  await expect(resolveProposalCommitPaths('s1', 'missing')).rejects.toThrow('Refresh the session');
  mocks.rows = [row({ proposalId: 'p1' })];
  await expect(resolveProposalCommitPaths('s1', 'p1')).rejects.toThrow('Refresh the session');
});
