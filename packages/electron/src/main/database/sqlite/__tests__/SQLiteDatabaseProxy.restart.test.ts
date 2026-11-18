// @vitest-environment node
/**
 * The SQLite worker can die under the app (an out-of-memory abort was seen in
 * the field) and every database call then failed with "SQLite worker not
 * running" until the user restarted Nimbalyst. These tests pin how the proxy
 * answers that death: a bounded restart of a worker that held the live
 * database, and no restart where some other owner manages the worker.
 *
 * The fake Worker copies what a real `worker_threads` Worker was observed to
 * do on Node 24 (2026-11-19 probe): an out-of-memory death first delivers any
 * reply the worker posted before it died, then emits `error` (code
 * ERR_WORKER_OUT_OF_MEMORY) and `exit` with code 1 in the same callback, with
 * no microtask checkpoint between them (`crashSync`, `replyThenDie`). An
 * uncaught exception leaves a turn between `error` and `exit`;
 * `crashOutOfMemory` emits its `exit` a turn later, or after `exitAfterMs`,
 * to cover that order and a slow teardown, since the proxy acts on whichever
 * event comes first. `postMessage` to a dead worker is silently dropped;
 * `terminate()` after `exit` resolves `undefined`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { StartMigrationPayload } from '../worker/workerProtocol';

interface Envelope {
  id: string;
  type: string;
  payload?: Record<string, unknown>;
}

const { FakeWorker, settings, warn } = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events');

  const outOfMemory = () =>
    Object.assign(new Error('Worker terminated due to reaching memory limit: JS heap out of memory'), {
      code: 'ERR_WORKER_OUT_OF_MEMORY',
    });

  class FakeWorker extends EventEmitter {
    static instances: FakeWorker[] = [];
    /** Applied to the next worker spawned, then cleared. */
    static nextSpawn: { holdInit?: boolean; initError?: string; crashOnInit?: boolean } = {};

    readonly n: number;
    readonly posted: Envelope[] = [];
    readonly hold = new Set<string>();
    private held = new Map<string, Envelope>();
    private initError?: string;
    private crashOnInit?: boolean;
    private dead = false;
    private open = false;

    constructor(readonly workerPath: string) {
      super();
      FakeWorker.instances.push(this);
      this.n = FakeWorker.instances.length;
      if (FakeWorker.nextSpawn.holdInit) this.hold.add('init');
      this.initError = FakeWorker.nextSpawn.initError;
      this.crashOnInit = FakeWorker.nextSpawn.crashOnInit;
      FakeWorker.nextSpawn = {};
    }

    postMessage(msg: Envelope | { bridgeResponse: true }): void {
      if (this.dead) return;
      if (!('type' in msg)) return;
      this.posted.push(msg);
      if (msg.type === 'init' && this.crashOnInit) {
        setImmediate(() => this.crashOutOfMemory());
        return;
      }
      if (this.hold.has(msg.type)) {
        this.held.set(msg.type, msg);
        return;
      }
      setImmediate(() => this.answer(msg));
    }

    /** Answer a request that `hold` kept in flight. */
    release(type: string): void {
      const msg = this.held.get(type);
      if (!msg) throw new Error(`no held ${type}`);
      this.held.delete(type);
      this.hold.delete(type);
      this.answer(msg);
    }

    private answer(msg: Envelope): void {
      if (this.dead) return;
      const fail = (message: string) =>
        this.emit('message', { id: msg.id, success: false, error: { message } });
      const ok = (data: unknown) => this.emit('message', { id: msg.id, success: true, data });
      switch (msg.type) {
        case 'init':
          if (this.initError) return void fail(this.initError);
          this.open = true;
          return void ok({ initMs: 1 });
        case 'close':
          this.open = false;
          return void ok({ closed: true });
        case 'query':
          // The real worker's `ensureInitialized()` message.
          if (!this.open) return void fail('SQLite worker not initialized');
          return void ok({ rows: [{ worker: this.n }] });
        default:
          return void ok({ ok: true });
      }
    }

    /** `exitAfterMs` delays the `exit` (a slow thread teardown) on the fake clock. */
    crashOutOfMemory(exitAfterMs?: number): void {
      this.dead = true;
      this.emit('error', outOfMemory());
      if (exitAfterMs === undefined) setImmediate(() => this.emit('exit', 1));
      else setTimeout(() => this.emit('exit', 1), exitAfterMs);
    }

    /** The real out-of-memory order: `error`, then `exit`, in one callback. */
    crashSync(): void {
      this.dead = true;
      this.emit('error', outOfMemory());
      this.emit('exit', 1);
    }

    /**
     * The worker answered a held request and then ran out of memory before
     * main had handled the answer: the answer, `error` and `exit` arrive in
     * one callback.
     */
    replyThenDie(type: string): void {
      this.release(type);
      this.crashSync();
    }

    /** A death that emits only `exit` (no `error` first). */
    exitUnexpectedly(code: number): void {
      this.dead = true;
      this.emit('exit', code);
    }

    terminate(): Promise<number | undefined> {
      if (this.dead) return Promise.resolve(undefined);
      this.dead = true;
      return new Promise((resolve) =>
        setImmediate(() => {
          this.emit('exit', 1);
          resolve(1);
        }),
      );
    }
  }

  return {
    FakeWorker,
    settings: { backupCopiesKept: 2 },
    warn: (await import('vitest')).vi.fn(),
  };
});

vi.mock('worker_threads', () => ({ Worker: FakeWorker }));
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp', getAppPath: () => '/tmp' },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../../utils/logger', () => ({
  logger: { main: { info: () => {}, warn, error: () => {} } },
}));
vi.mock('../../../utils/store', () => ({
  getDatabaseMaintenanceSettings: () => ({ backupCopiesKept: settings.backupCopiesKept }),
}));

import { SQLiteDatabaseProxy } from '../SQLiteDatabaseProxy';
import { classifyDatabaseError } from '../../DatabaseErrorTelemetry';

const DIRS = { dbDir: '/fake/userData/sqlite-db', schemaDir: '/fake/schemas' };
/** Longer than any restart backoff. */
const PAST_BACKOFF_MS = 5_000;

/** Let the fake worker's replies and `exit` events (real setImmediate) run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
}

async function liveProxy(): Promise<SQLiteDatabaseProxy> {
  const proxy = new SQLiteDatabaseProxy(DIRS);
  await proxy.initialize();
  return proxy;
}

function worker(n: number): InstanceType<typeof FakeWorker> {
  const w = FakeWorker.instances[n - 1];
  if (!w) throw new Error(`worker ${n} was never spawned (${FakeWorker.instances.length} spawned)`);
  return w;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  FakeWorker.instances = [];
  FakeWorker.nextSpawn = {};
  settings.backupCopiesKept = 2;
  warn.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SQLiteDatabaseProxy worker restart', () => {
  it.each([
    ['an out-of-memory error then exit', (w: InstanceType<typeof FakeWorker>) => w.crashOutOfMemory(), 'ERR_WORKER_OUT_OF_MEMORY'],
    ['an out-of-memory error and exit in one callback', (w: InstanceType<typeof FakeWorker>) => w.crashSync(), 'ERR_WORKER_OUT_OF_MEMORY'],
    ['an exit with no error',(w: InstanceType<typeof FakeWorker>) => w.exitUnexpectedly(1), 'exit code 1'],
  ])('after %s, the next query succeeds on one new worker that received init', async (_label, kill, reason) => {
    const proxy = await liveProxy();
    // The user changed backup retention since boot; the restart must not
    // hand the new worker the stale value (a lower one deletes copies).
    settings.backupCopiesKept = 3;
    kill(worker(1));
    await settle();

    const q = proxy.query('SELECT 1');
    await vi.advanceTimersByTimeAsync(PAST_BACKOFF_MS);
    await expect(q).resolves.toEqual({ rows: [{ worker: 2 }] });

    expect(worker(2).posted[0]).toEqual({
      id: expect.any(String),
      type: 'init',
      payload: { ...worker(1).posted[0].payload, backupCopiesKept: 3 },
    });
    expect(warn).toHaveBeenCalledWith(`[SQLiteProxy] restarting worker after ${reason} (restart 1 of 3)`);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWorker.instances).toHaveLength(2);
    expect(proxy.isInitialized()).toBe(true);
  });

  it('rejects a request in flight at the crash and never replays it on the new worker', async () => {
    const proxy = await liveProxy();
    worker(1).hold.add('query');
    const write = proxy.query('INSERT INTO t VALUES (1)').catch((e: Error) => e);
    worker(1).crashOutOfMemory();
    expect(((await write) as Error).message).toMatch(/memory limit/);
    await settle();

    const next = proxy.query('SELECT 1');
    await vi.advanceTimersByTimeAsync(PAST_BACKOFF_MS);
    await expect(next).resolves.toEqual({ rows: [{ worker: 2 }] });
    expect(worker(2).posted.map((m) => m.type)).toEqual(['init', 'query']);
    expect(worker(2).posted.some((m) => m.payload?.sql === 'INSERT INTO t VALUES (1)')).toBe(false);
  });

  it('holds a query issued during the restart until the new worker answered init, then runs it', async () => {
    const proxy = await liveProxy();
    FakeWorker.nextSpawn = { holdInit: true };
    worker(1).crashOutOfMemory();
    // Issued between the `error` and the `exit` event, when a post to the
    // dying worker would be dropped without a word.
    let settled = false;
    const q = proxy.query('SELECT 1');
    q.then(() => (settled = true), () => (settled = true));
    await settle();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(PAST_BACKOFF_MS);
    expect(worker(2).posted.map((m) => m.type)).toEqual(['init']);
    expect(settled).toBe(false);

    worker(2).release('init');
    await expect(q).resolves.toEqual({ rows: [{ worker: 2 }] });
  });

  it('a dead worker whose exit lands after the new worker spawned does not disturb the restart', async () => {
    const proxy = await liveProxy();
    FakeWorker.nextSpawn = { holdInit: true };
    worker(1).crashOutOfMemory(1_000);
    const q = proxy.query('SELECT 1');
    await vi.advanceTimersByTimeAsync(PAST_BACKOFF_MS);
    expect(worker(2).posted.map((m) => m.type)).toEqual(['init']);
    worker(2).release('init');
    await expect(q).resolves.toEqual({ rows: [{ worker: 2 }] });
    expect(FakeWorker.instances).toHaveLength(2);
  });

  it('a restarted worker that answers init and dies before main handled the answer counts as a death and is restarted again', async () => {
    const proxy = await liveProxy();
    FakeWorker.nextSpawn = { holdInit: true };
    worker(1).crashSync();
    const waiting = proxy.query('SELECT 1');
    await vi.advanceTimersByTimeAsync(PAST_BACKOFF_MS);
    expect(worker(2).posted.map((m) => m.type)).toEqual(['init']);

    // Main is busy (the out-of-memory case), so the answer, `error` and
    // `exit` all land before the restart sees its `init` succeed.
    worker(2).replyThenDie('init');
    await vi.advanceTimersByTimeAsync(PAST_BACKOFF_MS);
    await expect(waiting).resolves.toEqual({ rows: [{ worker: 3 }] });
    expect(warn).toHaveBeenCalledWith('[SQLiteProxy] restarting worker after ERR_WORKER_OUT_OF_MEMORY (restart 2 of 3)');
    expect(worker(3).posted.map((m) => m.type)).toEqual(['init', 'query']);
    expect(proxy.isInitialized()).toBe(true);
    expect(FakeWorker.instances).toHaveLength(3);
  });

  it('a last-budget restarted worker that answers init and dies leaves the proxy down with the reason, not initialized with no worker', async () => {
    const proxy = await liveProxy();
    for (let k = 1; k <= 2; k++) {
      worker(k).crashSync();
      const q = proxy.query('SELECT 1');
      await vi.advanceTimersByTimeAsync(PAST_BACKOFF_MS);
      await expect(q).resolves.toEqual({ rows: [{ worker: k + 1 }] });
    }
    FakeWorker.nextSpawn = { holdInit: true };
    worker(3).crashSync();
    const waiting = proxy.query('SELECT 1').catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(PAST_BACKOFF_MS);
    expect(worker(4).posted.map((m) => m.type)).toEqual(['init']);

    worker(4).replyThenDie('init');
    const cause = /^SQLite worker not running: .*3 restarts in 10 minutes/;
    expect(((await waiting) as Error).message).toMatch(cause);
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(proxy.isInitialized()).toBe(false);
    expect(FakeWorker.instances).toHaveLength(4);
    await expect(proxy.query('SELECT 1')).rejects.toThrow(cause);
    await expect(proxy.initialize()).rejects.toThrow(cause);
  });

  it('initialize() after a crash really re-initializes (the isInitialized/initialize guard callers use)', async () => {
    const proxy = await liveProxy();
    worker(1).crashOutOfMemory();
    await settle();
    expect(proxy.isInitialized()).toBe(false);

    const init = proxy.initialize();
    await vi.advanceTimersByTimeAsync(PAST_BACKOFF_MS);
    await init;
    expect(proxy.isInitialized()).toBe(true);
    expect(worker(2).posted[0].type).toBe('init');
    await expect(proxy.query('SELECT 1')).resolves.toEqual({ rows: [{ worker: 2 }] });
  });

  it('a worker that dies during the first init is not restarted, and a later initialize() tries again on a new worker', async () => {
    FakeWorker.nextSpawn = { holdInit: true };
    const proxy = new SQLiteDatabaseProxy(DIRS);
    const first = proxy.initialize().catch((e: Error) => e);
    await settle();
    worker(1).crashSync();
    expect(((await first) as Error).message).toMatch(/memory limit/);
    // Boot owns the first init: nothing restarts on its own.
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(FakeWorker.instances).toHaveLength(1);
    expect(proxy.isInitialized()).toBe(false);

    await proxy.initialize();
    expect(proxy.isInitialized()).toBe(true);
    expect(worker(2).posted.map((m) => m.type)).toEqual(['init']);
    await expect(proxy.query('SELECT 1')).resolves.toEqual({ rows: [{ worker: 2 }] });
  });

  it('a first init the live worker answers with an error stays the answer; only a death clears it', async () => {
    FakeWorker.nextSpawn = { initError: 'SQLITE_CANTOPEN: unable to open database file' };
    const proxy = new SQLiteDatabaseProxy(DIRS);
    await expect(proxy.initialize()).rejects.toThrow(/unable to open/);
    await expect(proxy.initialize()).rejects.toThrow(/unable to open/);
    expect(FakeWorker.instances).toHaveLength(1);
    expect(worker(1).posted.map((m) => m.type)).toEqual(['init']);
  });

  describe('close()', () => {
    it('an exit after close() does not restart', async () => {
      const proxy = await liveProxy();
      await proxy.close();
      await settle();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(FakeWorker.instances).toHaveLength(1);
      await expect(proxy.query('SELECT 1')).rejects.toThrow('SQLite worker not running');
    });

    it('a crash while close() is in flight does not restart', async () => {
      const proxy = await liveProxy();
      worker(1).hold.add('close');
      const closing = proxy.close();
      worker(1).crashOutOfMemory();
      await closing;
      await settle();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(FakeWorker.instances).toHaveLength(1);
    });

    it('close() during the restart backoff cancels the restart and rejects the waiting request', async () => {
      const proxy = await liveProxy();
      worker(1).crashOutOfMemory();
      const waiting = proxy.query('SELECT 1').catch((e: Error) => e);
      await settle();
      await proxy.close();
      expect(((await waiting) as Error).message).toMatch(/closed/);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(FakeWorker.instances).toHaveLength(1);
      expect(proxy.isInitialized()).toBe(false);
    });

    it('close() while the restart init is in flight leaves the proxy closed, not initialized', async () => {
      const proxy = await liveProxy();
      FakeWorker.nextSpawn = { holdInit: true };
      worker(1).crashOutOfMemory();
      const waiting = proxy.query('SELECT 1').catch((e: Error) => e);
      await settle();
      await vi.advanceTimersByTimeAsync(PAST_BACKOFF_MS);
      expect(worker(2).posted.map((m) => m.type)).toEqual(['init']);
      await proxy.close();
      expect(worker(2).posted.map((m) => m.type)).toEqual(['init', 'close']);
      expect(((await waiting) as Error).message).toMatch(/closed/);
      await settle();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(proxy.isInitialized()).toBe(false);
      expect(FakeWorker.instances).toHaveLength(2);
    });

    it('a restart init that succeeds while close() runs does not mark the proxy initialized', async () => {
      const proxy = await liveProxy();
      FakeWorker.nextSpawn = { holdInit: true };
      worker(1).crashOutOfMemory();
      const waiting = proxy.query('SELECT 1').catch((e: Error) => e);
      await settle();
      await vi.advanceTimersByTimeAsync(PAST_BACKOFF_MS);
      const closing = proxy.close();
      worker(2).release('init');
      expect(proxy.isInitialized()).toBe(false);
      await closing;
      expect(((await waiting) as Error).message).toMatch(/closed/);
      expect(proxy.isInitialized()).toBe(false);
    });

    it('close() and an immediate initialize() during the backoff leave one worker, the one initialize() opened', async () => {
      const proxy = await liveProxy();
      worker(1).crashOutOfMemory();
      await settle();
      const closing = proxy.close();
      const reopened = proxy.initialize();
      await closing;
      await reopened;
      await vi.advanceTimersByTimeAsync(60_000);
      await settle();
      expect(FakeWorker.instances).toHaveLength(2);
      await expect(proxy.query('SELECT 1')).resolves.toEqual({ rows: [{ worker: 2 }] });
    });

    it('an explicit initialize() after close() re-opens, and a later crash restarts again', async () => {
      const proxy = await liveProxy();
      await proxy.close();
      await proxy.initialize();
      worker(2).crashOutOfMemory();
      await settle();
      const q = proxy.query('SELECT 1');
      await vi.advanceTimersByTimeAsync(PAST_BACKOFF_MS);
      await expect(q).resolves.toEqual({ rows: [{ worker: 3 }] });
    });
  });

  it('a worker spawned only for migration work is not restarted when it dies', async () => {
    const proxy = new SQLiteDatabaseProxy(DIRS);
    proxy.ensureWorkerSpawned();
    worker(1).crashOutOfMemory();
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWorker.instances).toHaveLength(1);
    expect(worker(1).posted.map((m) => m.type)).toEqual([]);
  });

  it('a call that spawns on demand neither spawns beside a restart under way nor while the proxy stays down', async () => {
    const proxy = await liveProxy();
    worker(1).hold.add('restoreBackup');
    const restore = (proxy.getBackupService() as unknown as { restoreFromBackup(): Promise<unknown> })
      .restoreFromBackup()
      .catch((e: Error) => e);
    await settle();
    worker(1).crashOutOfMemory();
    await restore;
    await settle();
    await expect(proxy.dryRunStatus({ userDataPath: '/fake/userData', schemaDir: '/fake/schemas' })).rejects.toThrow(
      /SQLite worker not running.*'restoreBackup'/,
    );
    expect(FakeWorker.instances).toHaveLength(1);

    const other = await liveProxy();
    worker(2).crashOutOfMemory();
    await settle();
    const status = other.dryRunStatus({ userDataPath: '/fake/userData', schemaDir: '/fake/schemas' });
    await vi.advanceTimersByTimeAsync(PAST_BACKOFF_MS);
    await status;
    expect(FakeWorker.instances).toHaveLength(3);
    expect(worker(3).posted.map((m) => m.type)).toEqual(['init', 'migrationDryRunStatus']);
  });

  const selfManaged: Array<[string, (p: SQLiteDatabaseProxy) => Promise<unknown>]> = [
    ['restoreBackup', (p) => (p.getBackupService() as unknown as { restoreFromBackup(): Promise<unknown> }).restoreFromBackup()],
    ['verifyBackup', (p) => p.verifyBackup('/fake/userData/sqlite-db.backups/current.sqlite')],
    ['verifyCutover', (p) => p.verifyCutover()],
    ['migrationStart', (p) => p.startMigration({ userDataPath: '/fake/userData', schemaDir: '/fake/schemas' } as StartMigrationPayload)],
    ['migrationAdoptDryRun', (p) => p.adoptDryRun({ userDataPath: '/fake/userData', schemaDir: '/fake/schemas' } as never)],
  ];

  it.each(selfManaged)(
    'a crash while %s owns the worker leaves it down with an error naming the cause',
    async (type, start) => {
      const proxy = await liveProxy();
      worker(1).hold.add(type);
      const op = start(proxy).catch((e: Error) => e);
      await settle();
      expect(worker(1).posted.map((m) => m.type)).toContain(type);
      worker(1).crashOutOfMemory();
      expect(((await op) as Error).message).toMatch(/memory limit/);
      await settle();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(FakeWorker.instances).toHaveLength(1);
      const cause = new RegExp(`SQLite worker not running.*'${type}'`);
      await expect(proxy.query('SELECT 1')).rejects.toThrow(cause);
      await expect(proxy.initialize()).rejects.toThrow(cause);
      expect(FakeWorker.instances).toHaveLength(1);
    },
  );

  it('a self-managed request that already finished does not block a later restart', async () => {
    const proxy = await liveProxy();
    await proxy.verifyBackup('/fake/userData/sqlite-db.backups/current.sqlite');
    worker(1).crashOutOfMemory();
    await settle();
    const q = proxy.query('SELECT 1');
    await vi.advanceTimersByTimeAsync(PAST_BACKOFF_MS);
    await expect(q).resolves.toEqual({ rows: [{ worker: 2 }] });
  });

  it('after 3 restarts in 10 minutes the 4th crash leaves it down until close(), with a clear error', async () => {
    const proxy = await liveProxy();
    for (let k = 1; k <= 3; k++) {
      worker(k).crashOutOfMemory();
      await settle();
      const q = proxy.query('SELECT 1');
      await vi.advanceTimersByTimeAsync(PAST_BACKOFF_MS);
      await expect(q).resolves.toEqual({ rows: [{ worker: k + 1 }] });
    }
    expect(warn).toHaveBeenCalledWith('[SQLiteProxy] restarting worker after ERR_WORKER_OUT_OF_MEMORY (restart 3 of 3)');

    worker(4).crashOutOfMemory();
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWorker.instances).toHaveLength(4);
    const cause = /SQLite worker not running: .*3 restarts in 10 minutes/;
    await expect(proxy.query('SELECT 1')).rejects.toThrow(cause);
    await expect(proxy.initialize()).rejects.toThrow(cause);
    expect(FakeWorker.instances).toHaveLength(4);

    // The way out of the down state is the owner's explicit lifecycle.
    await proxy.close();
    await proxy.initialize();
    await expect(proxy.query('SELECT 1')).resolves.toEqual({ rows: [{ worker: 5 }] });
  });

  it('crashes spread wider than the 10-minute window keep restarting', async () => {
    const proxy = await liveProxy();
    for (let k = 1; k <= 4; k++) {
      worker(k).crashOutOfMemory();
      await settle();
      const q = proxy.query('SELECT 1');
      await vi.advanceTimersByTimeAsync(PAST_BACKOFF_MS);
      await expect(q).resolves.toEqual({ rows: [{ worker: k + 1 }] });
      await vi.advanceTimersByTimeAsync(4 * 60_000);
    }
  });

  it.each([
    ['answers init with an error', { initError: 'SQLITE_BUSY: database is locked' }, /restart 1 of 3 failed.*database is locked/],
    ['dies during init', { crashOnInit: true }, /restart 1 of 3 failed.*memory limit/],
    ['never answers init', { holdInit: true }, /restart 1 of 3 failed.*timed out/],
  ])('a restart whose worker %s counts as the attempt, stays down without looping and is reported as worker_unavailable', async (_label, spawn, cause) => {
    const proxy = await liveProxy();
    FakeWorker.nextSpawn = spawn;
    worker(1).crashOutOfMemory();
    await settle();
    const q = proxy.query('SELECT 1').catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(PAST_BACKOFF_MS);
    await settle();
    // Past the 120s init request timeout.
    await vi.advanceTimersByTimeAsync(120_000);
    await settle();
    expect(((await q) as Error).message).toMatch(cause);
    expect(((await q) as Error).message).toMatch(/^SQLite worker not running/);
    // The quoted cause ("database is locked", "timed out", "out of memory")
    // must not turn this into a locked, timed-out or out-of-memory database.
    expect(classifyDatabaseError(await q).errorCode).toBe('worker_unavailable');

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await settle();
    expect(FakeWorker.instances).toHaveLength(2);
    await expect(proxy.query('SELECT 1')).rejects.toThrow(cause);
    await expect(proxy.initialize()).rejects.toThrow(cause);
    expect(FakeWorker.instances).toHaveLength(2);
  });
});
