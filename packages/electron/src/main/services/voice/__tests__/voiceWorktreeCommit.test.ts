// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ target: vi.fn(async (): Promise<any> => null) }));
vi.mock('../../ai/gitCommitProposalPromptUtils', () => ({
  resolveGitCommitProposalPromptId: async (_s: string, id: string) => `canonical-${id}`,
  findGitCommitProposalWorktreeTarget: mocks.target,
}));

import { refuseVoiceWorktreeCommit } from '../voiceWorktreeCommit';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.target.mockResolvedValue(null);
});

// #1756: desktop realtime voice answers by prompt id only; the proposal row says where it commits.
it('refuses a spoken approval of a commit into another worktree', async () => {
  mocks.target.mockResolvedValue({ path: '/repo_wt/feature', branch: 'feature' });
  expect(await refuseVoiceWorktreeCommit('s1', { promptId: 'p1', promptType: 'git_commit_proposal_request', answer: 'approve' }))
    .toMatch(/commit card on desktop/);
  expect(mocks.target).toHaveBeenCalledWith('s1', 'canonical-p1');
});

it('lets rejections, ordinary commits and other prompt types through', async () => {
  expect(await refuseVoiceWorktreeCommit('s1', { promptId: 'p1', promptType: 'git_commit_proposal_request', answer: 'approve' })).toBeNull();
  mocks.target.mockResolvedValue({ path: '/repo_wt/feature', branch: 'feature' });
  expect(await refuseVoiceWorktreeCommit('s1', { promptId: 'p1', promptType: 'git_commit_proposal_request', answer: 'reject' })).toBeNull();
  expect(await refuseVoiceWorktreeCommit('s1', { promptId: 'p1', promptType: 'exit_plan_mode_request', answer: 'approve' })).toBeNull();
  // Only the ordinary approval reads the proposal row; rejections and other types never touch it.
  expect(mocks.target).toHaveBeenCalledTimes(1);
});
