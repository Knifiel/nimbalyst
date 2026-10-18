// @vitest-environment node
import { AgentMessagesRepository } from "@nimbalyst/runtime";
import { buildCodexToolLookupId } from "@nimbalyst/runtime/ai/server/toolLookupIds";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveGitCommitProposalPromptIdFromRows } from "../../services/ai/gitCommitProposalPromptUtils";
import {
  extractCodexTurnMetadataFromRequest,
  extractToolUseIdFromMcpRequest,
  findCodexAppServerToolCallId,
  resolveAskUserQuestionPromptTargets,
  resolvePromptTargets,
  resolveRequestUserInputPromptTargets,
  resolveToolUseIdFromMcpRequest,
} from "../tools/codexToolCallResolver";

describe("codexToolCallResolver", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("extracts Codex turn metadata from MCP request _meta", () => {
    expect(extractCodexTurnMetadataFromRequest({
      params: {
        _meta: {
          "x-codex-turn-metadata": {
            session_id: "session-1",
            thread_id: "thread-1",
            turn_id: "turn-1",
          },
        },
      },
    })).toEqual({
      sessionId: "session-1",
      threadId: "thread-1",
      turnId: "turn-1",
    });
  });

  it("extracts a direct tool-use id from provider metadata", () => {
    expect(extractToolUseIdFromMcpRequest({
      params: {
        _meta: {
          "openai/toolCallId": "call_direct",
        },
      },
    })).toBe("call_direct");
  });

  it("finds the raw call id for the matching turn and tool", () => {
    const contents = [
      JSON.stringify({
        method: "item/started",
        params: {
          turnId: "turn-0",
          item: { type: "mcpToolCall", tool: "PromptForUserInput", id: "call_old" },
        },
      }),
      JSON.stringify({
        method: "item/started",
        params: {
          turnId: "turn-1",
          item: { type: "mcpToolCall", tool: "PromptForUserInput", id: "call_match" },
        },
      }),
    ];

    expect(findCodexAppServerToolCallId(contents, "turn-1", "PromptForUserInput")).toBe("call_match");
    expect(findCodexAppServerToolCallId(contents, "turn-1", "AskUserQuestion")).toBeNull();
  });

  // #1784: Codex 0.162 sends `callId` (the transcript's mcpToolCall item id)
  // and `itemId` (an unrelated `ctc_` id). Keying the proposal on anything but
  // `callId` leaves the widget's `nimtc|exec-...` id unmatched, and the strict
  // git:commit lookup refuses with "Cannot identify this exact commit proposal".
  it("keys a Codex commit proposal on _meta.callId so the widget's id matches it exactly", async () => {
    const listTail = vi.spyOn(AgentMessagesRepository, "listTail");
    const request = {
      params: {
        name: "developer_git_commit_proposal",
        _meta: {
          progressToken: 1,
          callId: "exec-21d55d57-adc9-4a89-a25a-2d4c65520fe2",
          "x-codex-turn-metadata": { session_id: "thread-1", thread_id: "thread-1", turn_id: "turn-1" },
          threadId: "thread-1",
          sessionId: "thread-1",
          itemId: "ctc_0fbe3c48acdb3841016ad2418761a8819db104c73b372c2fb9",
        },
      },
    };

    const toolUseId = await resolveToolUseIdFromMcpRequest(request, "session-1", "developer_git_commit_proposal");
    expect(toolUseId).toBe("exec-21d55d57-adc9-4a89-a25a-2d4c65520fe2");
    expect(listTail).not.toHaveBeenCalled();

    const rows = [{
      content: JSON.stringify({ type: "git_commit_proposal", proposalId: toolUseId, toolUseId }),
      created_at: new Date(),
    }];
    const widgetId = buildCodexToolLookupId("exec-21d55d57-adc9-4a89-a25a-2d4c65520fe2", 1792164239296, 3);
    expect(resolveGitCommitProposalPromptIdFromRows(widgetId, rows, [], false)).toBe(toolUseId);
  });

  it("keeps Claude's tool-use id ahead of Codex callId", () => {
    expect(extractToolUseIdFromMcpRequest({
      params: { _meta: { "claudecode/toolUseId": "toolu_1", callId: "exec-1" } },
    })).toBe("toolu_1");
  });

  it("recovers the tool-use id from the newest messages, not the oldest", async () => {
    const started = {
      content: JSON.stringify({
        method: "item/started",
        params: {
          turnId: "turn-1",
          item: { type: "mcpToolCall", tool: "developer_git_commit_proposal", id: "exec-recent" },
        },
      }),
    };
    const oldest = Array.from({ length: 50 }, () => ({ content: JSON.stringify({ method: "item/completed" }) }));
    vi.spyOn(AgentMessagesRepository, "list").mockResolvedValue(oldest as any);
    vi.spyOn(AgentMessagesRepository, "listTail").mockResolvedValue([...oldest.slice(1), started] as any);

    await expect(resolveToolUseIdFromMcpRequest({
      params: { _meta: { "x-codex-turn-metadata": { turn_id: "turn-1" } } },
    }, "session-1", "developer_git_commit_proposal")).resolves.toBe("exec-recent");
  });

  // A turn can call the same tool twice. Guessing the first call's id keys the
  // second proposal on the wrong widget, and strict lookup then rejects it.
  it("recovers only an unambiguous in-flight call of the turn", () => {
    const row = (method: string, id: string, turnId = "turn-1") => JSON.stringify({
      method,
      params: { turnId, item: { type: "mcpToolCall", tool: "developer_git_commit_proposal", id } },
    });
    const tool = "developer_git_commit_proposal";

    // First call finished; the second is the one asking.
    expect(findCodexAppServerToolCallId(
      [row("item/started", "exec-1"), row("item/completed", "exec-1"), row("item/started", "exec-2")],
      "turn-1", tool,
    )).toBe("exec-2");
    // Two calls still open: no way to tell which one is asking.
    expect(findCodexAppServerToolCallId(
      [row("item/started", "exec-1"), row("item/started", "exec-2")],
      "turn-1", tool,
    )).toBeNull();
    // A completion without turnId still closes its start; one naming another turn does not.
    expect(findCodexAppServerToolCallId(
      [row("item/started", "exec-1"), JSON.stringify({
        method: "item/completed",
        params: { item: { type: "mcpToolCall", tool: "developer_git_commit_proposal", id: "exec-1" } },
      }), row("item/started", "exec-2")],
      "turn-1", tool,
    )).toBe("exec-2");
    expect(findCodexAppServerToolCallId(
      [row("item/started", "exec-1"), row("item/completed", "exec-1", "turn-0"), row("item/started", "exec-2")],
      "turn-1", tool,
    )).toBeNull();
    // The asking call's row is not persisted yet: never fall back to a finished call.
    expect(findCodexAppServerToolCallId(
      [row("item/started", "exec-1"), row("item/completed", "exec-1")],
      "turn-1", tool,
    )).toBeNull();
  });

  it("resolves the tool-use id from recent Codex app-server messages when direct metadata is missing", async () => {
    vi.spyOn(AgentMessagesRepository, "listTail").mockResolvedValue([
      {
        content: JSON.stringify({
          method: "item/started",
          params: {
            turnId: "turn-1",
            item: { type: "mcpToolCall", tool: "PromptForUserInput", id: "call_recovered" },
          },
        }),
      },
    ] as any);

    await expect(resolveToolUseIdFromMcpRequest({
      params: {
        _meta: {
          "x-codex-turn-metadata": {
            turn_id: "turn-1",
          },
        },
      },
    }, "session-1", "PromptForUserInput")).resolves.toBe("call_recovered");
  });

  it("resolves generic prompt targets, expanding synthetic ids", () => {
    expect(resolvePromptTargets("nimtc|call_generic|1779232811883|74")).toEqual({
      canonicalId: "nimtc|call_generic|1779232811883|74",
      rawId: "call_generic",
      waiterIds: ["nimtc|call_generic|1779232811883|74", "call_generic"],
    });
    expect(resolvePromptTargets("call_generic")).toEqual({
      canonicalId: "call_generic",
      waiterIds: ["call_generic"],
    });
  });

  it("expands synthetic prompt ids into waiter aliases", () => {
    expect(resolveRequestUserInputPromptTargets("nimtc|call_test|1779232811883|72")).toEqual({
      promptId: "nimtc|call_test|1779232811883|72",
      rawPromptId: "call_test",
      waiterPromptIds: ["nimtc|call_test|1779232811883|72", "call_test"],
    });
  });

  it("expands synthetic AskUserQuestion ids into waiter aliases", () => {
    expect(resolveAskUserQuestionPromptTargets("nimtc|call_question|1779232811883|73")).toEqual({
      questionId: "nimtc|call_question|1779232811883|73",
      rawQuestionId: "call_question",
      waiterQuestionIds: ["nimtc|call_question|1779232811883|73", "call_question"],
    });
  });

  it("keeps raw AskUserQuestion ids unchanged", () => {
    expect(resolveAskUserQuestionPromptTargets("call_question")).toEqual({
      questionId: "call_question",
      waiterQuestionIds: ["call_question"],
    });
  });
});
