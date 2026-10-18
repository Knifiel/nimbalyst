import {
  findGitCommitProposalWorktreeTarget,
  resolveGitCommitProposalPromptId,
} from '../ai/gitCommitProposalPromptUtils';
import { VOICE_WORKTREE_COMMIT_REFUSAL } from './mobileVoicePromptContract';

/** Desktop realtime voice answers by prompt id only; read the target from the proposal row. */
export async function refuseVoiceWorktreeCommit(
  sessionId: string,
  params: { promptId: string; promptType: string; answer: string },
): Promise<string | null> {
  if (params.promptType !== 'git_commit_proposal_request' || params.answer.toLowerCase() !== 'approve') return null;
  const proposalId = await resolveGitCommitProposalPromptId(sessionId, params.promptId, false);
  return (await findGitCommitProposalWorktreeTarget(sessionId, proposalId)) ? VOICE_WORKTREE_COMMIT_REFUSAL : null;
}
