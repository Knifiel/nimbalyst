// @vitest-environment node
// Real chokidar on a real tree: the other bus tests mock chokidar, which hides
// its `ready` counting. On Linux the bus adds expanded and bypassed paths to a
// handle whose initial scan may still be running, and `watching` must still
// mean the scan covered the tree (#2014).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const recorded = vi.hoisted(() => ({ handles: [] as any[] }));

vi.mock('chokidar', async (importOriginal) => {
  const actual: any = await importOriginal();
  const real = actual.default ?? actual;
  return {
    ...actual,
    default: {
      ...real,
      watch: (...args: any[]) => {
        const watcher = real.watch(...args);
        recorded.handles.push(watcher);
        return watcher;
      },
    },
  };
});
const nested = vi.hoisted(() => ({ list: undefined as undefined | ((root: string) => Promise<string[]>) }));
vi.mock('../../utils/gitUtils', async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    listIgnoredNestedRepositories: (root: string) => nested.list ? nested.list(root) : actual.listIgnoredNestedRepositories(root),
  };
});
vi.mock('../../utils/logger', () => ({
  logger: {
    main: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    workspaceWatcher: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  },
}));
vi.mock('../../utils/workspaceDetection', () => ({
  isPathInWorkspace: (filePath: string, workspacePath: string) =>
    !!filePath && !!workspacePath && (filePath === workspacePath || filePath.startsWith(workspacePath + '/')),
}));

import { subscribe, addGitignoreBypass, addWatchedPath, resetBus } from '../WorkspaceEventBus';
import { logger } from '../../utils/logger';
import type { FileWatchHealth } from '../../../shared/fileWatchHealth';

const DIRS = 400;
// The root plus d<i> and d<i>/inner.
const FULL = 1 + DIRS * 2;
let root: string;

const enospc = () => Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
const noEvents = { onAdd() {}, onChange() {}, onUnlink() {} };

function watchedDirs(handle: any): number {
  return Object.keys(handle.getWatched()).filter((dir) => dir === root || dir.startsWith(root + '/')).length;
}

describe.skipIf(process.platform !== 'linux')('WorkspaceEventBus on Linux: watching means the scan finished', () => {
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/var/tmp', 'bus-linux-scan-'));
    for (let d = 0; d < DIRS; d++) {
      const dir = path.join(root, `d${d}`, 'inner');
      fs.mkdirSync(dir, { recursive: true });
      for (let f = 0; f < 10; f++) fs.writeFileSync(path.join(dir, `f${f}.md`), 'x');
    }
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
  afterEach(async () => {
    resetBus();
    vi.useRealTimers();
    recorded.handles.length = 0;
    nested.list = undefined;
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it.each([
    ['a file an agent is about to create', (p: string) => addGitignoreBypass(root, p), 'agent-will-create.md'],
    ['an expanded folder that no longer exists', (p: string) => addWatchedPath(root, p), 'removed-folder'],
  ])('stays starting when %s is registered during the first scan', async (_label, register, name) => {
    let dirsAtWatching: number | undefined;
    await subscribe(root, 'scan', {
      ...noEvents,
      onHealthChanged: (health) => {
        if (health.state === 'watching' && dirsAtWatching === undefined) dirsAtWatching = watchedDirs(recorded.handles.at(-1));
      },
    });
    // subscribe() has returned, so the handle is installed and its scan is running.
    register(path.join(root, name));
    await vi.waitFor(() => expect(dirsAtWatching).toBeDefined(), { timeout: 10_000, interval: 20 });
    expect(dirsAtWatching).toBe(FULL);
  });

  it('C5: keeps an overflowed first scan until it finishes when a path it cannot stat is registered during the episode', async () => {
    const states: FileWatchHealth[] = [];
    let dirsAtWatching: number | undefined;
    await subscribe(root, 'scan', {
      ...noEvents,
      onHealthChanged: (health) => {
        states.push(health);
        if (health.state === 'watching' && dirsAtWatching === undefined) dirsAtWatching = watchedDirs(recorded.handles.at(-1));
      },
    });
    // The scan is running; a storm overflows the event backlog before it finishes.
    for (let i = 0; i < 16_600; i++) recorded.handles[0].emit('change', path.join(root, `storm-${i}.md`));
    expect(states.at(-1)).toMatchObject({ state: 'recovering', reason: 'event_queue_overflow' });
    addGitignoreBypass(root, path.join(root, 'agent-will-create.md'));
    await vi.waitFor(() => expect(dirsAtWatching).toBeDefined(), { timeout: 10_000, interval: 20 });
    expect(dirsAtWatching).toBe(FULL);
    expect(recorded.handles).toHaveLength(1);
  });

  it('keeps a retry with a stale bypass path starting until its scan finishes, so ENOSPC keeps escalating', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const states: FileWatchHealth[] = [];
    const capacityDelays: number[] = [];
    await subscribe(root, 'scan', {
      ...noEvents,
      onHealthChanged: (health) => {
        states.push(health);
        if (health.state === 'recovering' && health.reason === 'ENOSPC') capacityDelays.push(health.nextRetryAt! - Date.now());
      },
    });
    await vi.waitFor(() => expect(states.at(-1)?.state).toBe('watching'), { timeout: 10_000, interval: 20 });
    expect(watchedDirs(recorded.handles[0])).toBe(FULL);

    // An agent edited a file that was later deleted; its bypass stays registered.
    addGitignoreBypass(root, path.join(root, 'deleted-by-agent.md'));
    vi.mocked(logger.main.warn).mockClear();
    recorded.handles[0].emit('error', enospc());
    await new Promise((resolve) => setImmediate(resolve));
    vi.advanceTimersByTime(60_000);

    // Fail the retry 75 s into its scan, while the scan is still running.
    await new Promise<void>((resolve, reject) => {
      const probe = () => {
        const retry = recorded.handles[1];
        const dirs = retry ? watchedDirs(retry) : 0;
        if (dirs >= FULL) return reject(new Error('the retry scan finished before the probe saw it running'));
        if (dirs > 1) {
          vi.setSystemTime(Date.now() + 75_000);
          retry.emit('error', enospc());
          return resolve();
        }
        setImmediate(probe);
      };
      probe();
    });

    expect(states.filter((health) => health.state === 'watching' && health.generation > 1)).toEqual([]);
    expect(capacityDelays).toEqual([60_000, 300_000]);
    const limitWarnings = vi.mocked(logger.main.warn).mock.calls.filter(([message]) => String(message).includes('watch limit'));
    expect(limitWarnings).toHaveLength(1);
  });
  it('covers an ignored clone with its own depth budget by the time it publishes watching', async () => {
    const workspace = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/var/tmp', 'bus-linux-clone-'));
    try {
      fs.mkdirSync(path.join(workspace, '.git'));
      fs.writeFileSync(path.join(workspace, '.gitignore'), '/clone/\n');
      const clone = path.join(workspace, 'clone');
      fs.mkdirSync(path.join(clone, '.git'), { recursive: true });
      // Ten levels below the clone: past the root scan's depth budget, within the clone's own.
      let deep = path.join(clone, 'src');
      for (let level = 0; level < 9; level++) deep = path.join(deep, `l${level}`);
      fs.mkdirSync(deep, { recursive: true });
      // git takes a while to list ignored clones; the root scan is quick.
      nested.list = async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return [clone];
      };
      const watchedUnder = () => Object.keys(recorded.handles.at(-1).getWatched()).filter((dir) => dir.startsWith(clone + '/')).length;
      const added: string[] = [];
      let dirsAtWatching: number | undefined;
      await subscribe(workspace, 'clone-scan', {
        ...noEvents,
        onAdd: (filePath: string) => added.push(filePath),
        onHealthChanged: (health) => {
          if (health.state === 'watching' && dirsAtWatching === undefined) dirsAtWatching = watchedUnder();
        },
      });
      await vi.waitFor(() => expect(dirsAtWatching).toBeDefined(), { timeout: 10_000, interval: 20 });
      expect(dirsAtWatching).toBe(watchedUnder());
      const created = path.join(deep, 'generated.ts');
      fs.writeFileSync(created, 'x');
      await vi.waitFor(() => expect(added).toContain(created), { timeout: 5_000, interval: 20 });
    } finally {
      resetBus();
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  /**
   * An umbrella whose root ignores service/, a folder that is not yet a
   * repository, so chokidar never descends into it. `listed` records each
   * listing of the clones the root ignores, as git would answer it from disk.
   */
  function umbrellaWithFolderToClone(rootIsRepository = true) {
    const workspace = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/var/tmp', 'bus-linux-clone-'));
    if (rootIsRepository) fs.mkdirSync(path.join(workspace, '.git'));
    fs.writeFileSync(path.join(workspace, '.gitignore'), '/service/\n');
    const service = path.join(workspace, 'service');
    fs.mkdirSync(path.join(service, 'src'), { recursive: true });
    const listed: string[][] = [];
    return { workspace, service, listed, list: () => {
      const checkouts = [service].filter((dir) => fs.existsSync(path.join(dir, '.git')));
      listed.push(checkouts);
      return checkouts;
    } };
  }

  /** Two checkout-sized storms on `handle`, one overflow episode, between which service/ becomes a repository. */
  async function overflowWhileCloning(handle: any, service: string, states: FileWatchHealth[]) {
    const storm = (name: string) => {
      for (let i = 0; i < 16_600; i++) handle.emit('change', path.join(path.dirname(service), `${name}-${i}.md`));
    };
    storm('before');
    fs.mkdirSync(path.join(service, '.git'));
    storm('after');
    expect(states.filter((health) => health.state === 'recovering')).toEqual([
      expect.objectContaining({ reason: 'event_queue_overflow' }),
    ]);
    await vi.waitFor(() => expect(states.at(-1)?.state).toBe('watching'), { timeout: 10_000, interval: 20 });
  }

  it('N2: watches a clone the root ignores that a git init during an overflow episode created', async () => {
    const { workspace, service, listed, list } = umbrellaWithFolderToClone();
    try {
      nested.list = async () => list();
      const states: FileWatchHealth[] = [];
      const added: string[] = [];
      await subscribe(workspace, 'clone-init', {
        ...noEvents,
        onAdd: (filePath: string) => added.push(filePath),
        onHealthChanged: (health) => { states.push(health); },
      });
      await vi.waitFor(() => expect(states.at(-1)?.state).toBe('watching'), { timeout: 10_000, interval: 20 });
      const handle = recorded.handles[0];
      await overflowWhileCloning(handle, service, states);

      // Listed once for the episode and added to the same handle, which then scans the clone.
      await vi.waitFor(() => expect(Object.keys(handle.getWatched())).toContain(path.join(service, 'src')), { timeout: 10_000, interval: 20 });
      expect(listed).toEqual([[], [service]]);
      expect(recorded.handles).toHaveLength(1);
      const created = path.join(service, 'src', 'lib.ts');
      fs.writeFileSync(created, 'x');
      await vi.waitFor(() => expect(added).toContain(created), { timeout: 5_000, interval: 20 });
    } finally {
      resetBus();
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }, 40_000);

  it('N2: lists no clones when an overflow episode ends in a workspace that is not a repository', async () => {
    const { workspace, service, listed, list } = umbrellaWithFolderToClone(false);
    try {
      nested.list = async () => list();
      const states: FileWatchHealth[] = [];
      await subscribe(workspace, 'clone-init', { ...noEvents, onHealthChanged: (health) => { states.push(health); } });
      await vi.waitFor(() => expect(states.at(-1)?.state).toBe('watching'), { timeout: 10_000, interval: 20 });
      await overflowWhileCloning(recorded.handles[0], service, states);

      // The episode's listing starts before `watching` is reported, so none started.
      expect(listed).toEqual([]);
    } finally {
      resetBus();
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }, 40_000);

  it.each([
    ['the bus stops', () => resetBus()],
    ['a native failure replaces the handle', (handle: any) => handle.emit('error', Object.assign(new Error('EIO'), { code: 'EIO' }))],
  ])('N2: adds nothing to the old handle when %s before the episode listing answers', async (_label, interrupt) => {
    const { workspace, service, listed, list } = umbrellaWithFolderToClone();
    try {
      let answer!: () => void;
      nested.list = async () => {
        if (listed.length !== 1) return list();
        await new Promise<void>((resolve) => { answer = resolve; });
        return list();
      };
      const states: FileWatchHealth[] = [];
      await subscribe(workspace, 'clone-init', { ...noEvents, onHealthChanged: (health) => { states.push(health); } });
      await vi.waitFor(() => expect(states.at(-1)?.state).toBe('watching'), { timeout: 10_000, interval: 20 });
      const handle = recorded.handles[0];
      await overflowWhileCloning(handle, service, states);
      await vi.waitFor(() => expect(answer).toBeTypeOf('function'), { timeout: 10_000, interval: 20 });

      const add = vi.spyOn(handle, 'add');
      interrupt(handle);
      answer();
      // The listing has answered; a retry's start may list again for its own handle.
      await vi.waitFor(() => expect(listed.slice(0, 2)).toEqual([[], [service]]), { timeout: 10_000, interval: 20 });
      await new Promise((resolve) => setImmediate(resolve));
      expect(add).not.toHaveBeenCalled();
    } finally {
      resetBus();
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }, 40_000);
});
