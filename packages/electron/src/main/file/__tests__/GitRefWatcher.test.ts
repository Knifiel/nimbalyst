// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as path from 'path';

// Hoisted mocks: simple-git fakes that individual tests can wire per scenario,
// plus logger fakes that the vi.mock factory below references. Hoisting is
// required because vi.mock factories run before any non-hoisted top-level
// statements.
const {
  mockStatus,
  mockLog,
  loggerInfo,
  loggerError,
  loggerWarn,
  loggerDebug,
  mockWatchFile,
  mockUnwatchFile,
} = vi.hoisted(() => ({
  mockStatus: vi.fn(),
  mockLog: vi.fn(),
  loggerInfo: vi.fn(),
  loggerError: vi.fn(),
  loggerWarn: vi.fn(),
  loggerDebug: vi.fn(),
  mockWatchFile: vi.fn(),
  mockUnwatchFile: vi.fn(),
}));

vi.mock('simple-git', () => ({
  default: () => {
    const git = { status: mockStatus, log: mockLog, env: () => git };
    return git;
  },
}));

// Pretend `<workspace>/.git` is a regular directory.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    watchFile: mockWatchFile,
    unwatchFile: mockUnwatchFile,
    promises: {
      ...actual.promises,
      stat: vi.fn().mockResolvedValue({
        isDirectory: () => true,
        isFile: () => false,
      }),
      readFile: vi.fn(),
    },
  };
});

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    main: {
      info: loggerInfo,
      error: loggerError,
      warn: loggerWarn,
      debug: loggerDebug,
    },
  },
}));

vi.mock('../../ipc/GitStatusHandlers', () => ({
  clearGitStatusCache: vi.fn(),
}));

import { GitRefWatcher } from '../GitRefWatcher';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('GitRefWatcher lifecycle races', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStatus.mockResolvedValue({ current: 'main' });
    mockLog.mockResolvedValue({ latest: { hash: 'abc123', message: 'Initial commit' } });
  });

  it('shares one startup and releases every polling handle', async () => {
    const watcher = new GitRefWatcher();
    await Promise.all([watcher.start('/repo'), watcher.start('/repo'), watcher.start('/repo')]);
    expect(mockWatchFile).toHaveBeenCalledTimes(3);
    expect(mockStatus).toHaveBeenCalledTimes(1);
    await watcher.stop('/repo');
    expect(mockUnwatchFile.mock.calls).toEqual(
      mockWatchFile.mock.calls.map(([file, , listener]) => [file, listener]),
    );
  });

  it('allows a failed startup to be retried', async () => {
    mockStatus.mockRejectedValueOnce(new Error('Git is temporarily unavailable'));
    const watcher = new GitRefWatcher();
    await watcher.start('/repo');
    expect(mockWatchFile).not.toHaveBeenCalled();
    await watcher.start('/repo');
    expect(mockWatchFile).toHaveBeenCalledTimes(3);
    await watcher.stop('/repo');
  });

  it.each(['stop', 'stopAll'] as const)('%s cancels an unfinished startup', async (method) => {
    const status = deferred<{ current: string }>();
    mockStatus.mockReturnValueOnce(status.promise);
    const watcher = new GitRefWatcher();
    const starting = watcher.start('/repo');
    await vi.waitFor(() => expect(mockStatus).toHaveBeenCalledTimes(1));
    if (method === 'stop') await watcher.stop('/repo');
    else await watcher.stopAll();
    status.resolve({ current: 'main' });
    await starting;
    expect(mockWatchFile).not.toHaveBeenCalled();
    expect(watcher.getStats().activeWatchers).toBe(0);
  });

  it('does not let an obsolete startup replace or unregister its successor', async () => {
    const oldStatus = deferred<{ current: string }>();
    const newStatus = deferred<{ current: string }>();
    mockStatus.mockReturnValueOnce(oldStatus.promise).mockReturnValueOnce(newStatus.promise);
    const watcher = new GitRefWatcher();
    const oldStart = watcher.start('/repo');
    await vi.waitFor(() => expect(mockStatus).toHaveBeenCalledTimes(1));
    await watcher.stop('/repo');
    const newStart = watcher.start('/repo');
    await vi.waitFor(() => expect(mockStatus).toHaveBeenCalledTimes(2));
    oldStatus.resolve({ current: 'old' });
    await oldStart;
    const sharedStart = watcher.start('/repo');
    newStatus.resolve({ current: 'new' });
    await Promise.all([newStart, sharedStart]);
    expect(mockStatus).toHaveBeenCalledTimes(2);
    expect(mockWatchFile.mock.calls.map(([file]) => file)).toEqual([
      path.join('/repo', '.git/refs/heads/new'),
      path.join('/repo', '.git/index'),
      path.join('/repo', '.git/HEAD'),
    ]);
    await watcher.stopAll();
    expect(mockUnwatchFile).toHaveBeenCalledTimes(3);
  });

  it('does not recreate a branch poller when a HEAD lookup finishes after stop/restart', async () => {
    const watcher = new GitRefWatcher();
    await watcher.start('/repo');
    const status = deferred<{ current: string }>();
    mockStatus.mockReturnValueOnce(status.promise);
    const changingBranch = (watcher as any).handleHeadChange('/repo');
    await watcher.stop('/repo');
    await watcher.start('/repo');
    status.resolve({ current: 'retired-branch' });
    await changingBranch;
    expect(mockWatchFile).toHaveBeenCalledTimes(6);
    await watcher.stopAll();
    expect(mockUnwatchFile).toHaveBeenCalledTimes(6);
  });
});

describe('GitRefWatcher.start - empty repo handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips cleanly when git.log throws "does not have any commits yet"', async () => {
    mockStatus.mockResolvedValue({ current: 'master' });
    mockLog.mockRejectedValue(
      new Error("fatal: your current branch 'master' does not have any commits yet"),
    );

    const watcher = new GitRefWatcher();
    await expect(watcher.start('/fake/workspace')).resolves.toBeUndefined();

    expect(loggerInfo).toHaveBeenCalledWith(
      '[GitRefWatcher] Skipping workspace with no commits yet:',
      'workspace',
    );
    // The fresh-init path must NOT log via logger.error -- that was the
    // original symptom (multi-line stack trace in main.log).
    expect(loggerError).not.toHaveBeenCalled();

    expect(watcher.getStats().activeWatchers).toBe(0);
  });

  it('still logs error and skips when git.log throws an unrelated message', async () => {
    mockStatus.mockResolvedValue({ current: 'master' });
    mockLog.mockRejectedValue(new Error('unexpected git failure'));

    const watcher = new GitRefWatcher();
    await watcher.start('/fake/workspace');

    // The outer catch in start() handles all other errors and logs them.
    expect(loggerError).toHaveBeenCalledWith(
      '[GitRefWatcher] Failed to start watching:',
      expect.any(Error),
    );
    expect(watcher.getStats().activeWatchers).toBe(0);
  });

  it('skips detached HEAD workspaces (existing behavior preserved)', async () => {
    mockStatus.mockResolvedValue({ current: undefined });

    const watcher = new GitRefWatcher();
    await watcher.start('/fake/workspace');

    expect(loggerInfo).toHaveBeenCalledWith(
      '[GitRefWatcher] Skipping detached HEAD workspace:',
      '/fake/workspace',
    );
    expect(watcher.getStats().activeWatchers).toBe(0);
  });

  it('uses native file polling for git ref and index files', async () => {
    mockStatus.mockResolvedValue({ current: 'master' });
    mockLog.mockResolvedValue({ latest: { hash: 'abc123', message: 'Initial commit' } });

    const watcher = new GitRefWatcher();
    await watcher.start('/fake/workspace');

    // HEAD is watched alongside the branch ref: without it the ref watcher
    // stays pinned to whichever branch was current at start(), so after a
    // checkout no commit on the new branch is ever detected (#1403).
    const watched = [
      path.join('/fake/workspace', '.git', 'refs', 'heads', 'master'),
      path.join('/fake/workspace', '.git', 'index'),
      path.join('/fake/workspace', '.git', 'HEAD'),
    ];
    expect(mockWatchFile.mock.calls.map((call) => call[0])).toEqual(watched);
    expect(watcher.getStats().activeWatchers).toBe(1);

    await watcher.stop('/fake/workspace');

    expect(mockUnwatchFile.mock.calls.map((call) => call[0])).toEqual(watched);
    expect(watcher.getStats().activeWatchers).toBe(0);
  });

  it('re-points the ref watcher at the new branch when HEAD moves', async () => {
    mockStatus.mockResolvedValue({ current: 'master' });
    mockLog.mockResolvedValue({ latest: { hash: 'abc123', message: 'Initial commit' } });

    const watcher = new GitRefWatcher();
    await watcher.start('/fake/workspace');

    const headListener = mockWatchFile.mock.calls.find(
      (call) => call[0] === path.join('/fake/workspace', '.git', 'HEAD'),
    )?.[2];
    expect(headListener).toBeTypeOf('function');

    mockStatus.mockResolvedValue({ current: 'feature' });
    mockLog.mockResolvedValue({ latest: { hash: 'def456', message: 'On feature' } });

    // fs.watchFile hands the listener (curr, prev) stats; only a real change counts.
    await headListener!({ mtimeMs: 2, ctimeMs: 2, size: 1, ino: 1, nlink: 1 }, { mtimeMs: 1, ctimeMs: 1, size: 1, ino: 1, nlink: 1 });

    expect(mockUnwatchFile.mock.calls.map((call) => call[0])).toContain(
      path.join('/fake/workspace', '.git', 'refs', 'heads', 'master'),
    );
    expect(mockWatchFile.mock.calls.map((call) => call[0])).toContain(
      path.join('/fake/workspace', '.git', 'refs', 'heads', 'feature'),
    );
  });
});

/**
 * Watchers are registered per repo, and a repo can sit inside an attached
 * folder rather than at the workspace root. The pending-review side is still
 * workspace-scoped: `updateTagStatus`'s last argument becomes the key of the
 * `history:pending-count-changed` broadcast, and the renderer matches sessions
 * on exact workspace equality. Handing it a repo root means the badge refresh
 * reaches nobody after a commit in an attached repo.
 */
describe('GitRefWatcher - pending-review broadcast scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('attributes auto-approvals to the owning workspace, not the repo root', async () => {
    mockStatus.mockResolvedValue({ current: 'main' });
    mockLog.mockResolvedValue({ latest: { hash: 'abc123', message: 'Initial commit' } });

    const watcher = new GitRefWatcher();
    await watcher.start('/elsewhere/attached-repo', '/proj/primary');

    const updateTagStatus = vi.fn();
    await (watcher as any).autoApprovePendingReviews('/elsewhere/attached-repo', [
      '/elsewhere/attached-repo/src/a.ts',
    ], {
      getPendingTags: vi.fn().mockResolvedValue([{ id: 'tag-1' }]),
      updateTagStatus,
    });

    expect(updateTagStatus).toHaveBeenCalledWith(
      '/elsewhere/attached-repo/src/a.ts',
      'tag-1',
      'reviewed',
      '/proj/primary',
    );
  });

  it('keeps worktree review routing separate from its project lifetime', async () => {
    mockStatus.mockResolvedValue({ current: 'main' });
    mockLog.mockResolvedValue({ latest: { hash: 'abc123', message: 'Initial commit' } });

    const watcher = new GitRefWatcher();
    await watcher.start('/solo/repo', undefined, '/parent-project');

    const updateTagStatus = vi.fn();
    await (watcher as any).autoApprovePendingReviews('/solo/repo', ['/solo/repo/a.ts'], {
      getPendingTags: vi.fn().mockResolvedValue([{ id: 'tag-1' }]),
      updateTagStatus,
    });

    expect(updateTagStatus).toHaveBeenCalledWith(
      '/solo/repo/a.ts',
      'tag-1',
      'reviewed',
      '/solo/repo',
    );
  });
});

describe('GitRefWatcher project ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStatus.mockResolvedValue({ current: 'main' });
    mockLog.mockResolvedValue({ latest: { hash: 'abc123', message: 'Initial commit' } });
  });

  it('keeps shared repositories until the last interested workspace closes', async () => {
    const watcher = new GitRefWatcher();
    await Promise.all([watcher.start('/shared', '/a'), watcher.start('/shared', '/b')]);
    await watcher.start('/a-worktree', '/a');
    await watcher.pruneUnused((_repo, owners) => owners.has('/b'));
    expect(watcher.getStats().activeWatchers).toBe(1);
    expect(mockUnwatchFile).toHaveBeenCalledTimes(3);
    await watcher.pruneUnused(() => false);
    expect(watcher.getStats().activeWatchers).toBe(0);
    expect(mockUnwatchFile).toHaveBeenCalledTimes(6);
  });

  it('cancels a closed project’s startup and can watch it again on reopen', async () => {
    const status = deferred<{ current: string }>();
    mockStatus.mockReturnValueOnce(status.promise);
    const watcher = new GitRefWatcher();
    const starting = watcher.start('/repo', '/closed');
    await watcher.pruneUnused(() => false);
    status.resolve({ current: 'main' });
    await starting;
    expect(mockWatchFile).not.toHaveBeenCalled();
    mockStatus.mockResolvedValue({ current: 'main' });
    await watcher.start('/repo', '/reopened');
    await watcher.pruneUnused((_repo, owners) => owners.has('/reopened'));
    expect(watcher.getStats().activeWatchers).toBe(1);
    await watcher.stopAll();
  });
});
