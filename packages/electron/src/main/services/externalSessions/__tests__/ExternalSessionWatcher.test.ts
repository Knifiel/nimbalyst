// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { ExternalSessionWatcher } from "../ExternalSessionWatcher";
import { logger } from "../../../utils/logger";
import type { ExternalSessionIngestor } from "../ExternalSessionIngestor";

type DirListener = (type: string, filename: string | null) => void;

function harness(intervalMs = 60_000) {
  const handle = {
    on: vi.fn().mockReturnThis(),
    close: vi.fn(),
  };
  const source: any = {
    providerId: "claude-code",
    watchRoots: vi.fn(() => ["/logs"]),
    discover: vi.fn(async () => []),
    identify: vi.fn(),
    dispose: vi.fn(async () => {}),
  };
  const ingest = vi.fn<ExternalSessionIngestor["ingest"]>(async () => ({
    messagesAdded: 0,
    hasMore: false,
  }));
  const routes = vi.fn(async () => [
    { cwd: "/workspace", workspacePath: "/workspace" },
  ]);
  const scopeIsCurrent = vi.fn(() => true);
  const watch = vi.fn<
    (root: string, options: { recursive?: boolean }, listener: DirListener) => typeof handle
  >(() => handle);
  /** Delivers a directory event as fs.watch does: the name is relative to the watched root. */
  const emit = (root: string, filename: string) => {
    const call = watch.mock.calls.find(([watched]) => watched === root);
    if (!call) throw new Error(`No watch on ${root}`);
    call[2]("rename", filename);
  };
  const watcher = new ExternalSessionWatcher({
    sources: [source as any],
    ingestor: { ingest } as any,
    getRoutes: routes,
    watch: watch as any,
    scopeIsCurrent,
    intervalMs,
  });
  return { watcher, source, handle, routes, ingest, scopeIsCurrent, watch, emit };
}
describe("ExternalSessionWatcher", () => {
  it.each(["identify", "ingest"] as const)(
    "isolates a poisoned event's %s error from healthy events and discovery",
    async (failure) => {
      vi.useFakeTimers();
      const h = harness();
      const warning = vi.spyOn(logger.main, "warn");
      const poisonedError = Object.assign(
        new TypeError("private source content"),
        {
          name: "private custom error name",
        }
      );
      try {
        await h.watcher.start();
        const makeRef = (id: string) => ({
          providerId: "claude-code" as const,
          externalId: id,
          workspacePath: "/workspace",
          filePath: `/logs/${id}.jsonl`,
          updatedAt: 1,
        });
        h.source.identify.mockImplementation(async (file: string) => {
          if (failure === "identify" && file.includes("poison"))
            throw poisonedError;
          return makeRef(file.includes("poison") ? "poison" : "healthy-event");
        });
        h.ingest.mockImplementation(async (_source, ref) => {
          if (failure === "ingest" && ref.externalId === "poison")
            throw poisonedError;
          return { messagesAdded: 1, hasMore: false };
        });
        h.source.discover.mockResolvedValue([makeRef("healthy-discovery")]);
        h.emit("/logs", "poison.jsonl");
        h.emit("/logs", "healthy.jsonl");
        await vi.advanceTimersToNextTimerAsync();
        expect(h.ingest.mock.calls.map(([, ref]) => ref.externalId)).toContain(
          "healthy-event"
        );
        expect(h.ingest.mock.calls.map(([, ref]) => ref.externalId)).toContain(
          "healthy-discovery"
        );
        expect(warning).toHaveBeenCalledWith(
          "[ExternalSessions] Event batch failed; scoped discovery will retry",
          {
            providerId: "claude-code",
            filePath: "/logs/poison.jsonl",
            errorName: "TypeError",
          }
        );
        expect(JSON.stringify(warning.mock.calls)).not.toContain("private");
      } finally {
        await h.watcher.stop();
        warning.mockRestore();
        vi.useRealTimers();
      }
    }
  );
  it("revisits unchanged eligible EOF files on periodic discovery and cancels that work on stop", async () => {
    vi.useFakeTimers();
    const h = harness(5000);
    h.source.discover.mockResolvedValue([
      {
        providerId: "claude-code",
        externalId: "idle-file",
        workspacePath: "/workspace",
        filePath: "/logs/idle.jsonl",
        updatedAt: 1,
      },
    ]);
    try {
      await h.watcher.start();
      expect(h.ingest).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(5000);
      expect(h.ingest).toHaveBeenCalledTimes(2);
      expect(h.source.identify).not.toHaveBeenCalled();
      await h.watcher.stop();
      await vi.advanceTimersByTimeAsync(10000);
      expect(h.ingest).toHaveBeenCalledTimes(2);
    } finally {
      await h.watcher.stop();
      vi.useRealTimers();
    }
  });
  it("skips a settled file on later discovery passes until its file stamp changes", async () => {
    vi.useFakeTimers();
    const h = harness(5000);
    let stamp = { inode: 1, size: 10, mtimeMs: 1 };
    h.source.discover.mockImplementation(
      async (_cwd: string, options?: { skipUnchanged?: Function }) =>
        options?.skipUnchanged?.("/logs/idle.jsonl", stamp)
          ? []
          : [
              {
                providerId: "claude-code",
                externalId: "idle-file",
                workspacePath: "/workspace",
                filePath: "/logs/idle.jsonl",
                updatedAt: 1,
              },
            ]
    );
    h.ingest.mockResolvedValueOnce({
      messagesAdded: 0,
      hasMore: false,
      skipped: true,
    });
    h.ingest.mockResolvedValue({
      messagesAdded: 0,
      hasMore: false,
      settled: true,
    });
    try {
      await h.watcher.start();
      // An unsettled outcome (e.g. a transient ownership skip) is retried.
      await vi.advanceTimersByTimeAsync(5000);
      expect(h.ingest).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(15000);
      expect(h.ingest).toHaveBeenCalledTimes(2);
      stamp = { ...stamp, size: 20, mtimeMs: 2 };
      await vi.advanceTimersByTimeAsync(5000);
      expect(h.ingest).toHaveBeenCalledTimes(3);
      // Restarting the watcher (setting toggle) forgets every settled stamp.
      await h.watcher.stop();
      await h.watcher.start();
      expect(h.ingest).toHaveBeenCalledTimes(4);
    } finally {
      await h.watcher.stop();
      vi.useRealTimers();
    }
  });
  it("preserves every reference from a discovery page across bounded ticks without filesystem events", async () => {
    vi.useFakeTimers();
    const h = harness();
    const refs = Array.from({ length: 100 }, (_, index) => ({
      providerId: "claude-code",
      externalId: `session-${index}`,
      workspacePath: "/workspace",
      filePath: `/logs/session-${index}.jsonl`,
      updatedAt: 1,
    }));
    h.source.discover.mockResolvedValue(refs);
    try {
      await h.watcher.start();
      expect(h.ingest.mock.calls.length).toBeLessThanOrEqual(64);
      for (let pass = 0; pass < 4; pass++) {
        const before = h.ingest.mock.calls.length;
        await vi.advanceTimersByTimeAsync(100);
        expect(h.ingest.mock.calls.length - before).toBeLessThanOrEqual(64);
      }
      expect(
        new Set(h.ingest.mock.calls.map(([, ref]) => ref.externalId)).size
      ).toBe(100);
      expect(h.source.identify).not.toHaveBeenCalled();
      expect(h.source.discover).toHaveBeenCalledTimes(1);
      // A later regular poll leaves another page tail, which must be discarded
      // if its workspace closes before the continuation.
      await vi.advanceTimersToNextTimerAsync();
      expect(h.ingest).toHaveBeenCalledTimes(164);
      h.routes.mockResolvedValue([]);
      const beforeClose = h.ingest.mock.calls.length;
      await vi.advanceTimersByTimeAsync(100);
      expect(h.ingest).toHaveBeenCalledTimes(beforeClose);
      await h.watcher.stop();
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.ingest).toHaveBeenCalledTimes(beforeClose);
    } finally {
      await h.watcher.stop();
      vi.useRealTimers();
    }
  });

  it("watches only explicit roots and revokes queued discoveries synchronously on stop", async () => {
    const h = harness();
    let resolve!: (refs: any[]) => void;
    h.source.discover.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        })
    );
    const start = h.watcher.start();
    await vi.waitFor(() =>
      expect(h.source.discover).toHaveBeenCalledWith(
        "/workspace",
        expect.anything()
      )
    );
    const stop = h.watcher.stop();
    resolve([
      {
        providerId: "claude-code",
        externalId: "id",
        workspacePath: "/workspace",
        filePath: "/logs/id.jsonl",
      },
    ]);
    await Promise.all([start, stop]);
    expect(h.ingest).not.toHaveBeenCalled();
    expect(h.handle.close).toHaveBeenCalledTimes(1);
    expect(h.source.dispose).toHaveBeenCalledTimes(1);
  });
  it("watches each root as one directory, recursive only for leaves, and ignores historical Codex trees", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.source.watchRoots.mockReturnValue([
      "/codex/sessions",
      "/codex/sessions/2026",
      "/codex/sessions/2026/09",
      "/codex/sessions/2026/09/14",
    ]);
    await h.watcher.start();
    // One directory handle per root, never one per file under it.
    expect(
      h.watch.mock.calls.map(([root, options]) => [root, options.recursive])
    ).toEqual([
      ["/codex/sessions", false],
      ["/codex/sessions/2026", false],
      ["/codex/sessions/2026/09", false],
      ["/codex/sessions/2026/09/14", process.platform !== "linux"],
    ]);
    h.emit("/codex/sessions", "2025/01/01/rollout-old.jsonl");
    h.emit("/codex/sessions/2026/09/14", "rollout-live.jsonl");
    await vi.advanceTimersToNextTimerAsync();
    expect(h.source.identify).toHaveBeenCalledWith(
      "/codex/sessions/2026/09/14/rollout-live.jsonl",
      ["/workspace"]
    );
    expect(h.source.identify).not.toHaveBeenCalledWith(
      "/codex/sessions/2025/01/01/rollout-old.jsonl",
      expect.anything()
    );
    await h.watcher.stop();
    vi.useRealTimers();
    expect(h.handle.close).toHaveBeenCalledTimes(4);
  });
  it("retries a root that does not exist yet on the next scan", async () => {
    vi.useFakeTimers();
    const h = harness(5000);
    try {
      h.watch.mockImplementationOnce(() => {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      });
      await h.watcher.start();
      expect(h.watch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5000);
      expect(h.watch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(5000);
      expect(h.watch).toHaveBeenCalledTimes(2);
    } finally {
      await h.watcher.stop();
      vi.useRealTimers();
    }
  });
  it("revokes a source read when its workspace closes between scan and commit", async () => {
    const h = harness();
    h.source.discover.mockResolvedValue([
      {
        providerId: "claude-code",
        externalId: "id",
        workspacePath: "/workspace",
        filePath: "/logs/id.jsonl",
      },
    ] as any);
    let eligibleAfterClose = true;
    h.ingest.mockImplementation(async (_source, _ref, _route, options) => {
      expect(options!.isEligible!()).toBe(true);
      h.scopeIsCurrent.mockReturnValue(false);
      eligibleAfterClose = options!.isEligible!();
      return { messagesAdded: 0, hasMore: false };
    });
    await h.watcher.start();
    expect(eligibleAfterClose).toBe(false);
    await h.watcher.stop();
  });
  it("rejects ambiguous cwd ownership and does not fall back to unscoped discovery", async () => {
    const h = harness();
    h.routes.mockResolvedValue([
      { cwd: "/tree", workspacePath: "/a" },
      { cwd: "/tree", workspacePath: "/b" },
    ]);
    await h.watcher.start();
    expect(h.source.discover).not.toHaveBeenCalled();
    await h.watcher.stop();
  });
});

it("finds a newly created scoped Codex root, follows date rollover, and stops importing after close", async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const os = await import("node:os");
  const { CodexSource } = await import("../CodexSource");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "external-watcher-"));
  let now = new Date("2026-09-14T23:59:00Z");
  const source = new CodexSource({
    rootDir: path.join(dir, "sessions"),
    now: () => now,
  });
  const ingest = vi.fn<ExternalSessionIngestor["ingest"]>(async () => ({
    messagesAdded: 1,
    hasMore: false,
  }));
  const watcher = new ExternalSessionWatcher({
    sources: [source],
    ingestor: { ingest } as any,
    getRoutes: async () => [{ cwd: "/workspace", workspacePath: "/workspace" }],
    intervalMs: 20,
  });
  const write = async (date: string, id: string) => {
    const file = path.join(dir, "sessions", date, `rollout-${id}.jsonl`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      JSON.stringify({
        type: "session_meta",
        timestamp: now.toISOString(),
        payload: { id, cwd: "/workspace" },
      }) + "\n"
    );
  };
  try {
    await watcher.start();
    expect(ingest).not.toHaveBeenCalled();
    await write("2026/09/14", "today");
    await vi.waitFor(() =>
      expect(
        ingest.mock.calls.some(([, ref]) => ref.externalId === "today")
      ).toBe(true)
    );
    now = new Date("2026-09-15T00:01:00Z");
    await write("2026/09/15", "tomorrow");
    await write("2025/01/01", "historical");
    await vi.waitFor(() =>
      expect(
        ingest.mock.calls.some(([, ref]) => ref.externalId === "tomorrow")
      ).toBe(true)
    );
    expect(
      ingest.mock.calls.some(([, ref]) => ref.externalId === "historical")
    ).toBe(false);
    await watcher.stop();
    const count = ingest.mock.calls.length;
    await write("2026/09/15", "after-stop");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(ingest).toHaveBeenCalledTimes(count);
  } finally {
    await watcher.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
