// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

const rows = vi.hoisted(() => ({ all: [] as Array<{ content: string }> }));
vi.mock("@nimbalyst/runtime/storage/repositories/AgentMessagesRepository", () => ({
  AgentMessagesRepository: {
    // Mirrors the real stores: `list` pages from the oldest row, `listTail` from the newest.
    list: async (_sessionId: string, options?: { limit?: number }) => rows.all.slice(0, options?.limit ?? rows.all.length),
    listTail: async (_sessionId: string, limit: number) => rows.all.slice(-limit),
  },
}));

import { buildToolPermissionResponseRecord } from "../../services/ai/claudeCliToolPermission";
import { findGitCommitProposalResponse, findToolPermissionResponse } from "../tools/promptResponsePoll";

const filler = (n: number) => Array.from({ length: n }, (_, i) => ({ content: JSON.stringify({ type: "text", i }) }));

describe("findToolPermissionResponse", () => {
  // Same oldest-rows bug as the commit waiter: past 50 rows a lost IPC answer
  // was never found and the request sat until the 10-minute deny.
  it("finds the answer written at the end of a long session", async () => {
    const answer = (requestId: string, decision: "allow" | "deny") => ({
      content: JSON.stringify(buildToolPermissionResponseRecord({
        requestId,
        answer: { decision, scope: "once" },
        respondedBy: "desktop",
        respondedAt: 1,
      })),
    });
    rows.all = [...filler(200), answer("perm-other", "deny"), answer("perm-1", "allow")];

    await expect(findToolPermissionResponse("s-1", "perm-1")).resolves.toMatchObject({ decision: "allow" });
    await expect(findToolPermissionResponse("s-1", "perm-missing")).resolves.toBeNull();
  });
});

describe("findGitCommitProposalResponse", () => {
  // #1682: the fallback read the oldest 20 rows, so in any real session it never
  // saw the response and a lost IPC reply left the commit call hanging.
  it("finds the response written at the end of a long session", async () => {
    rows.all = [
      ...Array.from({ length: 200 }, (_, i) => ({ content: JSON.stringify({ type: "text", i }) })),
      { content: JSON.stringify({ type: "git_commit_proposal", proposalId: "p-1" }) },
      { content: JSON.stringify({ type: "git_commit_proposal_response", proposalId: "p-other", action: "cancelled" }) },
      { content: JSON.stringify({ type: "git_commit_proposal_response", proposalId: "p-1", action: "committed", commitHash: "abc1234" }) },
    ];

    await expect(findGitCommitProposalResponse("s-1", "p-1")).resolves.toMatchObject({ action: "committed", commitHash: "abc1234" });
    await expect(findGitCommitProposalResponse("s-1", "p-missing")).resolves.toBeNull();
  });
});
