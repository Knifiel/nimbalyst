// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const records = vi.hoisted(() => new Map<string, unknown>());
const writes = vi.hoisted(() => ({ failResults: false }));
vi.mock("../../../utils/privateSettingsStore", () => ({
  default: class {
    constructor(private options: { name: string }) {}
    get(key: string) {
      return records.get(this.options.name + key);
    }
    set(key: string, value: any) {
      if (writes.failResults && value?.result) throw new Error("ENOSPC: no space left on device");
      records.set(this.options.name + key, value);
    }
  },
}));
import {
  runCommitProposalOnce,
  cancelCommitProposalOnce,
  reserveCommitProposalCancel,
  acceptsCommitProposalResponse,
  commitProposalOutcome,
  resetCommitProposalExecutionMemoryForTests,
} from "../CommitProposalExecution";
import { reservePromptAnswer } from "../PromptAnswerReservation";
import {
  beginCommitProposalConfirm,
  isCommitProposalInFlight,
} from "@nimbalyst/runtime/ai/server/commitProposalInFlight";
beforeEach(() => {
  records.clear();
  resetCommitProposalExecutionMemoryForTests();
  writes.failResults = false;
});
describe("shared card and voice answer boundary", () => {
  it("reserves a commit before awaiting Git, retains the real failure, and blocks cancellation/replay", async () => {
    let finish!: () => void;
    const execute = vi.fn(async () => {
      await new Promise<void>((r) => {
        finish = r;
      });
      return { success: false, error: "hook failed" };
    });
    const first = runCommitProposalOnce("s", "p", "selection", execute);
    expect(await cancelCommitProposalOnce("s", "p")).toBe(false);
    expect(
      acceptsCommitProposalResponse("s", "p", {
        action: "error",
        error: "Already executing",
      })
    ).toBe(false);
    expect(
      (await runCommitProposalOnce("s", "p", "selection", execute)).success
    ).toBe(false);
    finish();
    expect(await first).toEqual({ success: false, error: "hook failed" });
    expect(
      acceptsCommitProposalResponse("s", "p", {
        action: "error",
        error: "hook failed",
      })
    ).toBe(true);
    expect(
      acceptsCommitProposalResponse("s", "p", { action: "cancelled" })
    ).toBe(false);
    expect(await runCommitProposalOnce("s", "p", "selection", execute)).toEqual(
      { success: false, error: "hook failed" }
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(await cancelCommitProposalOnce("s", "other")).toBe(true);
    expect(
      (await runCommitProposalOnce("s", "other", "selection", execute)).success
    ).toBe(false);
  });
  // #1682: an outcome is this proposal's own recorded execution, never a look-alike commit.
  it("reports a commit only from the proposal's own execution record", async () => {
    await runCommitProposalOnce("other-session", "p", "selection", async () => ({ success: true, commitHash: "theirs" }));
    expect(await commitProposalOutcome("s", "p")).toEqual({ kind: "not-committed" });

    await runCommitProposalOnce("s", "failed", "selection", async () => ({ success: false, error: "timed out waiting for lock" }));
    expect(await commitProposalOutcome("s", "failed")).toEqual({ kind: "not-committed" });
    await cancelCommitProposalOnce("s", "cancelled");
    expect(await commitProposalOutcome("s", "cancelled")).toEqual({ kind: "not-committed" });
  });

  it("waits for an earlier, abandoned execution of the same proposal and reports its commit", async () => {
    let finish!: () => void;
    const abandoned = runCommitProposalOnce("s", "p", "selection", async () => {
      await new Promise<void>((r) => { finish = r; });
      return { success: true, commitHash: "abc1234", commitDate: "2026-10-16" };
    });
    const outcome = commitProposalOutcome("s", "p");
    finish();
    expect(await outcome).toEqual({ kind: "committed", commitHash: "abc1234", commitDate: "2026-10-16" });
    await abandoned;
    expect(await commitProposalOutcome("s", "p")).toMatchObject({ kind: "committed", commitHash: "abc1234" });
  });

  // #1682: the card, voice and mobile all commit through here, so this is the
  // window send-now and teammate interrupts must wait out. A cancel runs no git.
  it("holds the session's interrupts while a proposal's commit executes, and not for a cancel", async () => {
    let during = false;
    await runCommitProposalOnce("held", "p", "selection", async () => {
      during = isCommitProposalInFlight("held");
      return { success: true, commitHash: "abc1234" };
    });
    expect(during).toBe(true);
    expect(isCommitProposalInFlight("held")).toBe(false);

    expect(await cancelCommitProposalOnce("held", "c")).toBe(true);
    expect(isCommitProposalInFlight("held")).toBe(false);
  });

  // Round 2 review: a supersede reserved its cancel only after an await, so a
  // Stop in that gap released the proposal as "stays open" and the closing row
  // landed anyway. The reservation has to be decided before returning.
  it("reserves a cancel synchronously and refuses one a commit already owns", async () => {
    expect(reserveCommitProposalCancel("s", "p")).toBe(true);
    expect(acceptsCommitProposalResponse("s", "p", { action: "cancelled" })).toBe(true);
    expect(reserveCommitProposalCancel("s", "p")).toBe(true);
    expect((await runCommitProposalOnce("s", "p", "selection", async () => ({ success: true, commitHash: "x" }))).success).toBe(false);
    expect(isCommitProposalInFlight("s")).toBe(false);

    let finish!: () => void;
    const commit = runCommitProposalOnce("s", "q", "selection", async () => {
      await new Promise<void>((r) => { finish = r; });
      return { success: true, commitHash: "abc1234" };
    });
    expect(reserveCommitProposalCancel("s", "q")).toBe(false);
    finish();
    await commit;
    expect(reserveCommitProposalCancel("s", "q")).toBe(false);
  });

  // Round 2 review: the card's Confirm awaits path resolution before the commit
  // reserves its record; a cancel in that gap must lose to the Confirm.
  it("refuses a cancel once the user's Confirm for that proposal is accepted", () => {
    const endConfirm = beginCommitProposalConfirm("s", "confirmed");
    expect(reserveCommitProposalCancel("s", "confirmed")).toBe(false);
    expect(reserveCommitProposalCancel("s", "other")).toBe(true);
    endConfirm();
    expect(reserveCommitProposalCancel("s", "confirmed")).toBe(true);
  });

  // Re-review: git succeeded but recording the result threw, which left the tool call unsettled.
  it("still returns and reports a commit git made when recording its result fails", async () => {
    writes.failResults = true;
    const result = await runCommitProposalOnce("s", "p", "selection", async () => ({ success: true, commitHash: "abc1234" }));
    expect(result).toMatchObject({ success: true, commitHash: "abc1234" });
    expect(await commitProposalOutcome("s", "p")).toMatchObject({ kind: "committed", commitHash: "abc1234" });
  });

  // Final review: the response gate and dedup read only the durable record, so after a failed
  // write the card's normal answer was rejected and the MCP waiter never settled.
  it("accepts the normal response and dedups retries when the result write failed", async () => {
    writes.failResults = true;
    const execute = vi.fn(async () => ({ success: true, commitHash: "abc1234" }));
    await runCommitProposalOnce("s", "p", "selection", execute);
    expect(acceptsCommitProposalResponse("s", "p", { action: "committed", commitHash: "abc1234" })).toBe(true);
    expect(acceptsCommitProposalResponse("s", "p", { action: "cancelled" })).toBe(false);
    expect(await runCommitProposalOnce("s", "p", "selection", execute)).toMatchObject({ success: true, commitHash: "abc1234" });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("allows UI persistence then delivery, rejecting a competing answer and repeated dispatch", async () => {
    const yes = { decision: "allow", scope: "once" };
    expect(reservePromptAnswer("s", "permission", "p", yes, "record")).toBe(
      true
    );
    expect(
      reservePromptAnswer("s", "permission", "p", { decision: "deny" })
    ).toBe(false);
    expect(reservePromptAnswer("s", "permission", "p", yes)).toBe(true);
    expect(reservePromptAnswer("s", "permission", "p", yes)).toBe(false);
    vi.resetModules();
    const restarted = await import("../PromptAnswerReservation");
    expect(restarted.reservePromptAnswer("s", "permission", "p", yes)).toBe(
      false
    );
    const answer = { answers: { Scope: "This file" } };
    expect(reservePromptAnswer("s", "question", "q", answer)).toBe(true);
    expect(
      reservePromptAnswer(
        "s",
        "question",
        "q",
        { answers: { Scope: "Everything" } },
        "record"
      )
    ).toBe(false);
    expect(reservePromptAnswer("other-session", "question", "q", answer)).toBe(
      true
    );
  });
});
