import { AgentMessagesRepository } from "@nimbalyst/runtime/storage/repositories/AgentMessagesRepository";
import {
  parseToolPermissionResponseRecord,
  type ToolPermissionAnswer,
} from "../../services/ai/claudeCliToolPermission";

/**
 * Database fallbacks for interactive-prompt waiters: find the durable response
 * row the prompt handler wrote, for when the IPC reply is lost.
 */

export interface PolledGitCommitProposalResponse {
  action: "committed" | "cancelled" | "error";
  commitHash?: string;
  commitDate?: string;
  error?: string;
  filesCommitted?: string[];
  commitMessage?: string;
}

/**
 * The newest rows: `list` pages from the oldest row and never reaches a
 * response written late in a session (#1682).
 */
async function findInRecentRows<T>(
  sessionId: string,
  match: (content: string) => T | null,
): Promise<T | null> {
  const messages = await AgentMessagesRepository.listTail(sessionId, 50);
  for (const msg of messages) {
    const found = match(msg.content);
    if (found) return found;
  }
  return null;
}

export function findGitCommitProposalResponse(
  sessionId: string,
  proposalId: string,
): Promise<PolledGitCommitProposalResponse | null> {
  return findInRecentRows(sessionId, (raw) => {
    try {
      const content = JSON.parse(raw);
      if (
        content.type === "git_commit_proposal_response" &&
        content.proposalId === proposalId
      ) {
        return {
          action: content.action || "cancelled",
          commitHash: content.commitHash,
          commitDate: content.commitDate,
          error: content.error,
          filesCommitted: content.filesCommitted,
          commitMessage: content.commitMessage,
        };
      }
    } catch {
      // Not valid JSON, skip
    }
    return null;
  });
}

export function findToolPermissionResponse(
  sessionId: string,
  requestId: string,
): Promise<ToolPermissionAnswer | null> {
  return findInRecentRows(sessionId, (raw) => parseToolPermissionResponseRecord(raw, requestId));
}
