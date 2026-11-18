/**
 * SQLiteDatabaseProxy
 *
 * Main-thread proxy that mirrors the public surface of `SQLiteDatabase` but
 * forwards every call to a `worker_threads` Worker. Reasoning: better-sqlite3
 * is synchronous on the calling thread. Running it on main blocks the
 * Electron IPC loop while any query is in flight — the dashboard scans on a
 * 7.5 GB DB demonstrated this with multi-second freezes. The PGLite backend
 * lived in a worker for exactly this reason; SQLite gets the same treatment.
 *
 * Surface kept compatible with `SQLiteDatabase` so existing call sites
 * (`database.query / queryReadOnly / exec / getStats / verifyBackup /
 * createBackup / setBackupService / close / isInitialized / initialize`)
 * continue to compile unchanged.
 *
 * Surface NOT exposed (worker-internal): `getRawHandle`, `getInstrumentation`,
 * `getCoordinator`, `runBackground`, `prepare`. Callers that used those
 * have been migrated to the explicit `pragmaRead` / `dashboardTableStats` /
 * `getPerformance` methods below.
 *
 * Worker lifecycle: a single Worker is spawned by `initialize()`. It lives
 * for the app lifetime. `close()` shuts it down. Each `query/exec/etc.` call
 * issues a uuid-keyed request; the response handler resolves the matching
 * promise. Errors crossing the boundary are reconstructed into real Errors
 * so try/catch in callers behaves the same as before.
 *
 * If the worker that holds the live database dies (it has run out of heap in
 * the field), the proxy starts a new one and re-sends `init`; see
 * `handleWorkerDeath`. Before that, every later call failed with "SQLite
 * worker not running" until the app was restarted (#1649).
 */

import { serializeBridgeError } from './worker/migrationReadBridge';
import type { CutoverVerification } from './cutoverVerification';
import { Worker } from 'worker_threads';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getDatabaseMaintenanceSettings } from '../../utils/store';
import { app, BrowserWindow } from 'electron';
import { observeMigrationProgress } from '../migrationOperation';
import { logger } from '../../utils/logger';
import { getPackageRoot } from '../../utils/appPaths';
import type { AppDatabaseBackupService } from '../PGLiteDatabaseWorker';
import type {
  InitPayload,
  QueryResult,
  ResponseEnvelope,
  WorkerRequestType,
  SerializedError,
  MigrationPreflightResult,
  StartMigrationPayload,
  AdoptDryRunPayload,
  DryRunStatusResult,
  PgliteReadRequestPayload,
  WorkerControlRequestPayload,
} from './worker/workerProtocol';
import type { MigrationSummary } from './PGLiteToSQLiteMigrator';
import type { DryRunResult } from './MigrationDryRunner';
import type { AdoptResult } from './MigrationAdopter';
import { emitMigrationOutcome } from './migrationEventMapper';
import { MIGRATION_OUTCOME_EVENT, type MigrationOutcome } from './migrationOutcome';

/**
 * Read surface satisfied by the live PGLite worker. The proxy hands every
 * `pgliteReadRequest` event from the SQLite worker to this callback so the
 * migration pipeline running inside the SQLite worker can pull rows from
 * PGLite (which lives in a different worker_threads thread).
 */
export interface LivePgliteReader {
  assertAvailable?: () => void;
  queryReadOnly<T = unknown>(
    sql: string,
    params?: unknown[],
    timeoutMs?: number,
  ): Promise<{ rows: T[] }>;
}

/**
 * Control hooks the migration pipeline can ask main to run. Currently only
 * `closePglite`; new actions go through the same `workerControlRequest` event
 * channel so we don't proliferate one-off message types.
 */
export interface MigrationControlHandler {
  closePglite: () => Promise<void>;
  onCutoverSuccess?: (info: { sqliteDir: string; pgliteMigratedDir: string }) => Promise<void> | void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  /**
   * Timeout handle, cleared on response or rejection so we don't leak a
   * 60-second timer per query into the Node timer wheel. Under sustained AI
   * streaming load (1000s of writes/reads per session) the leaked timers
   * dominate event-loop CPU even after the queries themselves resolve.
   */
  timer?: ReturnType<typeof setTimeout>;
}

export interface SQLiteDatabaseProxyOptions {
  /** Directory holding `nimbalyst.sqlite` and its WAL/SHM siblings. */
  dbDir: string;
  /** Directory holding the migration SQL files. */
  schemaDir: string;
  /** Slow-query log threshold in ms. Default 100. */
  slowQueryThresholdMs?: number;
  /** Sample rate (0..1) for the instrumentation rolling window. */
  sampleRate?: number;
  /** Request timeout in ms (default 60s; init uses 120s). */
  requestTimeoutMs?: number;
}


/**
 * Backup requests copy and scan the whole database, so their duration scales
 * with the store, not with a UI expectation: a 6.3 GB database takes ~44s for
 * the online copy alone. Under the default 60s request timeout the proxy gave
 * up, dropped the pending entry, and discarded the success response that
 * arrived later — so a backup that in fact completed was logged as failed and
 * never recorded in backup health. This ceiling is a bus-drop guard only.
 */
const BACKUP_REQUEST_TIMEOUT_MS = 30 * 60_000;

const INIT_REQUEST_TIMEOUT_MS = 120_000;

/**
 * Restart budget for a worker that died while it held the live database. A
 * worker that keeps dying is not restarted forever: past this many restarts
 * inside the window, the proxy stays down and every call says why.
 */
const MAX_WORKER_RESTARTS = 3;
const WORKER_RESTART_WINDOW_MS = 10 * 60_000;
/** Restart k waits `WORKER_RESTART_BACKOFF_MS * 2^(k-1)`: 0.5s, 1s, 2s. */
const WORKER_RESTART_BACKOFF_MS = 500;

/**
 * Requests whose operation manages the worker's lifecycle itself (migration,
 * cutover, restore, backup verification). If the worker dies while one of
 * these is in flight, it is not restarted and the proxy stays down: a restore
 * or cutover may have moved the live database, and reopening the live path
 * then would create an empty database there.
 */
const SELF_MANAGED_REQUESTS: ReadonlySet<WorkerRequestType> = new Set<WorkerRequestType>([
  'migrationPreflight',
  'migrationStart',
  'migrationStartDryRun',
  'migrationDryRunStatus',
  'migrationAdoptDryRun',
  'verifyCutover',
  'restoreBackup',
  'verifyBackup',
]);

/** Resolve the on-disk path to the SQLite worker bundle. */
function resolveWorkerPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'sqlite-worker.bundle.js');
  }
  return path.join(getPackageRoot(), 'out', 'sqlite-worker.bundle.js');
}

export class SQLiteDatabaseProxy {
  private worker: Worker | null = null;
  private pending = new Map<string, PendingRequest>();
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private opts: SQLiteDatabaseProxyOptions;
  /**
   * Per the PGLite worker pattern: the backup service is wired on the worker
   * side at init. The setBackupService() method exists for API parity with
   * SQLiteDatabase but is a no-op — the worker constructs SQLiteBackupService
   * during `init` because that service needs the raw handle.
   */
  private backupServiceFacade: AppDatabaseBackupService;
  private pgliteReader: LivePgliteReader | null = null;
  private migrationControl: MigrationControlHandler | null = null;
  private migrationObserver: ((event: string, payload: unknown) => void) | null = null;
  /** Set when `close()` starts; only an explicit `initialize()` clears it. Blocks every restart. */
  private closeRequested = false;
  /** Bumped by `close()` so a restart that was under way stops at its next step. */
  private lifecycleGeneration = 0;
  /**
   * In-flight `SELF_MANAGED_REQUESTS`, by request id. Removed by the reply or
   * by the worker's death, never by the request timeout: a restore that timed
   * out on this side may still be moving files on the worker.
   */
  private selfManagedInFlight = new Map<string, WorkerRequestType>();
  /** The restart under way: backoff, spawn, `init`. Requests wait on it. */
  private restartPromise: Promise<void> | null = null;
  private wakeRestartBackoff: (() => void) | null = null;
  /** When each restart in the current window started. */
  private restartTimes: number[] = [];
  /** Set when a dead worker is not restarted; every call rejects with it until `close()`. */
  private downError: Error | null = null;

  constructor(opts: SQLiteDatabaseProxyOptions) {
    this.opts = opts;
    this.backupServiceFacade = this.makeBackupFacade();
  }

  /**
   * Inject the live PGLite reader the worker uses to pull source rows during
   * migration. Must be set before calling `startMigration` / `startDryRun` /
   * `adoptDryRun`; preflight and dryRunStatus tolerate it being unset.
   */
  setPgliteReader(reader: LivePgliteReader): void {
    this.pgliteReader = reader;
  }

  /**
   * Observe migration progress on the main process. Used by the boot-time
   * forced migration to drive the splash screen; the renderer path uses the
   * IPC broadcast instead.
   */
  setMigrationObserver(observer: (event: string, payload: unknown) => void): void {
    this.migrationObserver = observer;
  }

  /** Inject the control handler used for `closePglite` / cutover hooks. */
  setMigrationControl(handler: MigrationControlHandler): void {
    this.migrationControl = handler;
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  async initialize(): Promise<void> {
    if (this.initialized) return;
    // After a worker death this is the restart under way, or the rejection
    // that says why the proxy stays down.
    if (this.initPromise) return this.initPromise;
    this.closeRequested = false;
    this.initPromise = this.doInitialize();
    return this.initPromise;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Spawn the worker without sending `init`. Used by migration callers that
   * need the worker thread for the orchestrator/dry-runner/adopter but don't
   * want to open the live SQLite handle yet (or ever, when PGLite is still
   * the active backend).
   */
  ensureWorkerSpawned(): void {
    // A restart under way spawns its own worker; a proxy that stays down
    // spawns none until `close()`.
    if (!this.worker && !this.restartPromise && !this.downError) this.createWorker();
  }

  private async doInitialize(): Promise<void> {
    this.ensureWorkerSpawned();
    await this.send('init', this.buildInitPayload(), INIT_REQUEST_TIMEOUT_MS);
    this.initialized = true;
  }

  private buildInitPayload(): InitPayload {
    return {
      dbDir: this.opts.dbDir,
      schemaDir: this.opts.schemaDir,
      slowQueryThresholdMs: this.opts.slowQueryThresholdMs,
      sampleRate: this.opts.sampleRate,
      // Resolved here rather than in the worker: electron-store needs the
      // `electron` module, which a worker bundle cannot resolve. Read again
      // on a restart: the user may have raised it since boot, and a stale
      // lower value would delete copies at the next rotation.
      backupCopiesKept: getDatabaseMaintenanceSettings().backupCopiesKept,
    };
  }

  async close(): Promise<void> {
    this.closeRequested = true;
    this.lifecycleGeneration++;
    this.restartPromise = null;
    this.wakeRestartBackoff?.();
    const worker = this.worker;
    if (worker) {
      try {
        await this.post('close', undefined, 30_000);
      } catch (err) {
        logger.main.warn('[SQLiteProxy] close request failed', err);
      }
      try {
        await worker.terminate();
      } catch {
        /* ignore */
      }
      if (this.worker === worker) this.worker = null;
    }
    // Fail any in-flight pending requests so callers don't hang.
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error('SQLiteDatabaseProxy closed'));
    }
    this.pending.clear();
    this.selfManagedInFlight.clear();
    this.initialized = false;
    this.initPromise = null;
    this.downError = null;
  }

  // --------------------------------------------------------------------------
  // Query surface (parity with SQLiteDatabase)
  // --------------------------------------------------------------------------

  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    return (await this.send('query', { sql, params })) as QueryResult<T>;
  }

  async queryReadOnly<T = unknown>(
    sql: string,
    params: unknown[] = [],
    timeoutMs?: number,
  ): Promise<QueryResult<T>> {
    // Bound the timeout aggressively on the main side so an inflight callback
    // can't outlast a sensible UI window. Worker enforces its own timeout via
    // `db.interrupt()` for the actual statement.
    const requestTimeout = (timeoutMs ?? 5000) + 5000;
    return (await this.send(
      'queryReadOnly',
      { sql, params, timeoutMs },
      requestTimeout,
    )) as QueryResult<T>;
  }

  async exec(sql: string): Promise<void> {
    await this.send('exec', { sql });
  }

  async runTransaction(statements: Array<{ sql: string; params?: unknown[]; expectedRows?: number }>): Promise<void> {
    await this.send('transaction', { statements });
  }

  async getStats(): Promise<unknown> {
    return this.send('getStats');
  }

  async verifyBackup(backupPath: string): Promise<{
    valid: boolean;
    error?: string;
    hasData?: boolean;
    sessionCount?: number;
    historyCount?: number;
  }> {
    return (await this.send('verifyBackup', { backupPath }, BACKUP_REQUEST_TIMEOUT_MS)) as {
      valid: boolean;
      error?: string;
      hasData?: boolean;
      sessionCount?: number;
      historyCount?: number;
    };
  }

  async createBackup(): Promise<{ success: boolean; error?: string }> {
    return (await this.send(
      'createBackup',
      undefined,
      BACKUP_REQUEST_TIMEOUT_MS,
    )) as { success: boolean; error?: string };
  }

  /** Read-side backup status (returns null when no backup has run yet). */
  async getBackupStatusAsync(): Promise<unknown> {
    return this.send('getBackupStatus');
  }

  /** Parity with SQLiteDatabase; on the proxy the backup service lives in the worker. */
  setBackupService(_svc: AppDatabaseBackupService): void {
    // Intentional no-op. See backupServiceFacade for the read-side façade.
  }

  getBackupService(): AppDatabaseBackupService {
    return this.backupServiceFacade;
  }

  /** Mirrors `SQLiteDatabase.getDB()` so `AppDatabase`-typed callers compile. */
  getDB(): {
    query: <T = unknown>(sql: string, params?: unknown[]) => Promise<QueryResult<T>>;
    exec: (sql: string) => Promise<void>;
  } {
    if (!this.initialized) {
      throw new Error('SQLiteDatabaseProxy not initialized. Call initialize() first.');
    }
    return {
      query: <T = unknown>(sql: string, params?: unknown[]) => this.query<T>(sql, params ?? []),
      exec: (sql: string) => this.exec(sql),
    };
  }

  // --------------------------------------------------------------------------
  // Dashboard / performance helpers (replace previous getRawHandle uses)
  // --------------------------------------------------------------------------

  async pragmaRead(name: string): Promise<unknown> {
    const r = (await this.send('pragmaRead', { name })) as { value: unknown };
    return r.value;
  }

  async dashboardTableStats(): Promise<unknown> {
    return this.send('dashboardTableStats');
  }

  async getSlowQueries(limit = 50): Promise<unknown[]> {
    return (await this.send('getSlowQueries', { limit })) as unknown[];
  }

  async getPerformance(slowLimit = 50): Promise<{ snapshot: unknown; slowQueries: unknown[] }> {
    return (await this.send('getPerformance', { slowLimit })) as {
      snapshot: unknown;
      slowQueries: unknown[];
    };
  }

  async walCheckpoint(): Promise<unknown> {
    return this.send('walCheckpoint');
  }

  /** Apply a new backup-retention setting to the live service. */
  async setBackupCopiesKept(copiesKept: number): Promise<void> {
    await this.send('setBackupCopiesKept', { copiesKept });
  }

  /**
   * Estimate what the tool-output retention pass would reclaim, from a bounded
   * sample. Cheap enough for a confirmation prompt.
   */
  async toolRetentionEstimate(retentionDays: number): Promise<{
    sampledRows: number;
    sampleBytesSaved: number;
    candidateRows: number;
    estimatedBytesSaved: number;
  }> {
    return (await this.send('toolRetentionEstimate', { retentionDays })) as {
      sampledRows: number;
      sampleBytesSaved: number;
      candidateRows: number;
      estimatedBytesSaved: number;
    };
  }

  /**
   * Run the retention pass. Executes on the worker's background lane, so the
   * app stays responsive while it works.
   */
  async toolRetentionRun(retentionDays: number, maxRows?: number, startAfterId?: number): Promise<unknown> {
    return this.send('toolRetentionRun', { retentionDays, maxRows, startAfterId });
  }

  /**
   * Delete raw rows that render nothing, and collapse duplicate session/init
   * frames. Separate from `toolRetentionRun` because it removes rows rather
   * than rewriting payloads; see `createRawMessagePruneWork`.
   */
  async rawMessagePruneRun(
    retentionDays: number,
    maxRows?: number,
    ignoreAge?: boolean,
  ): Promise<unknown> {
    return this.send('rawMessagePruneRun', { retentionDays, maxRows, ignoreAge });
  }

  // --------------------------------------------------------------------------
  // Migration surface — drives MigrationOrchestrator / MigrationDryRunner /
  // MigrationAdopter inside the worker. Progress events are fanned out to
  // BrowserWindows on the existing `db:migration:*` channels via the
  // event-handling block in createWorker().
  // --------------------------------------------------------------------------

  async migrationPreflight(args: {
    userDataPath: string;
    schemaDir: string;
  }): Promise<MigrationPreflightResult> {
    this.ensureWorkerSpawned();
    return (await this.send('migrationPreflight', args, 60_000)) as MigrationPreflightResult;
  }

  async startMigration(args: StartMigrationPayload): Promise<{ summary: MigrationSummary }> {
    this.ensureWorkerSpawned();
    // Migration can take a very long time on large DBs; bound generously.
    // Worker side guards against concurrent starts.
    this.pgliteReader?.assertAvailable?.();
    return (await this.send('migrationStart', args, 60 * 60 * 1000)) as {
      summary: MigrationSummary;
    };
  }

  async startDryRun(args: {
    cancellation?: SharedArrayBuffer;
    userDataPath: string;
    schemaDir: string;
  }): Promise<{ result: DryRunResult }> {
    this.ensureWorkerSpawned();
    this.pgliteReader?.assertAvailable?.();
    return (await this.send('migrationStartDryRun', args, 60 * 60 * 1000)) as {
      result: DryRunResult;
    };
  }

  async dryRunStatus(args: {
    userDataPath: string;
    schemaDir: string;
  }): Promise<DryRunStatusResult> {
    this.ensureWorkerSpawned();
    return (await this.send('migrationDryRunStatus', args, 30_000)) as DryRunStatusResult;
  }

  async adoptDryRun(args: AdoptDryRunPayload): Promise<{ result: AdoptResult }> {
    this.ensureWorkerSpawned();
    this.pgliteReader?.assertAvailable?.();
    return (await this.send('migrationAdoptDryRun', args, 60 * 60 * 1000)) as {
      result: AdoptResult;
    };
  }

  async verifyCutover(receipt?: CutoverVerification): Promise<void> {
    await this.send('verifyCutover', { receipt }, 120_000);
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  private createWorker(): void {
    const workerPath = resolveWorkerPath();
    logger.main.info('[SQLiteProxy] spawning worker', { workerPath, dbDir: this.opts.dbDir });
    const worker = new Worker(workerPath);
    this.worker = worker;

    worker.on(
      'message',
      (
        msg:
          | ResponseEnvelope
          | { event: string; payload: unknown }
          | { event: string; bridgeId: string; payload: unknown },
      ) => {
        if ('event' in msg) {
          this.handleWorkerEvent(msg as { event: string; bridgeId?: string; payload: unknown });
          return;
        }
        this.selfManagedInFlight.delete(msg.id);
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);
        if (pending.timer) clearTimeout(pending.timer);
        if (msg.success) {
          pending.resolve(msg.data);
        } else {
          const err = new Error(msg.error.message);
          if (msg.error.name) err.name = msg.error.name;
          if (msg.error.stack) err.stack = msg.error.stack;
          if (msg.error.code) (err as { code?: string }).code = msg.error.code;
          // Carries `MigrationRefusedError`'s structured verdict across the
          // thread hop; without it a refusal arrives as an ordinary Error and
          // the boot path counts it as a failed attempt.
          if (msg.error.data !== undefined) (err as { data?: unknown }).data = msg.error.data;
          pending.reject(err);
        }
      },
    );

    // A worker's `error` event is always followed by `exit` (an out-of-memory
    // death emits ERR_WORKER_OUT_OF_MEMORY, then exit code 1). The death is
    // handled on whichever comes first: a request posted in between would be
    // dropped by the dead thread without a reply.
    worker.on('error', (err) => {
      logger.main.error('[SQLiteProxy] worker error', err);
      const code = (err as { code?: string }).code;
      this.handleWorkerDeath(worker, err, code ?? `worker error: ${err.message}`);
    });

    worker.on('exit', (code) => {
      if (code !== 0) {
        logger.main.warn('[SQLiteProxy] worker exited with code', code);
      }
      this.handleWorkerDeath(worker, new Error(`SQLite worker exited (code ${code})`), `exit code ${code}`);
    });
  }

  /**
   * A worker died. Requests in flight on it reject with `cause` and are never
   * replayed: a write may already have committed. If it held the live
   * database (its `init` succeeded) and nothing else owns its lifecycle, a
   * new worker is started and sent `init` again; otherwise the proxy stays
   * down, or is left to whoever owns it.
   *
   * A restart reaches only what the worker's `init` does: open the existing
   * `nimbalyst.sqlite` (SQLite replays its own WAL), set pragmas, apply schema
   * migrations not yet recorded (none, in the same process), and load backup
   * metadata. No rename, delete, backup rotation or recovery runs.
   */
  private handleWorkerDeath(worker: Worker, cause: Error, reason: string): void {
    // A worker `close()` already let go of, or the `exit` after an `error`.
    if (this.worker !== worker) return;
    const heldLiveDatabase = this.initialized;
    const selfManaged = this.selfManagedInFlight.values().next().value;
    this.selfManagedInFlight.clear();
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(cause);
    }
    this.pending.clear();
    this.worker = null;
    this.initialized = false;

    // Migration-only workers, a death during the first `init` (that `init`
    // rejects to its caller), and app shutdown are not restarted.
    if (!heldLiveDatabase || this.closeRequested) return;

    if (selfManaged) {
      this.stayDown(
        new Error(
          `SQLite worker not running: it stopped (${reason}) during '${selfManaged}', which manages the worker itself, so it was not restarted`,
        ),
      );
      return;
    }

    const now = Date.now();
    this.restartTimes = this.restartTimes.filter((t) => now - t < WORKER_RESTART_WINDOW_MS);
    if (this.restartTimes.length >= MAX_WORKER_RESTARTS) {
      this.stayDown(
        new Error(
          `SQLite worker not running: it stopped again (${reason}) after ${MAX_WORKER_RESTARTS} restarts in ${WORKER_RESTART_WINDOW_MS / 60_000} minutes, so it was not restarted; restart Nimbalyst`,
        ),
      );
      return;
    }
    this.restartTimes.push(now);
    const attempt = this.restartTimes.length;
    logger.main.warn(
      `[SQLiteProxy] restarting worker after ${reason} (restart ${attempt} of ${MAX_WORKER_RESTARTS})`,
    );
    const restart = this.restartWorker(attempt, this.lifecycleGeneration);
    // Waiting requests and `initialize()` callers see the outcome; this only
    // keeps an unobserved rejection quiet.
    restart.catch(() => {});
    this.restartPromise = restart;
    this.initPromise = restart;
  }

  private async restartWorker(attempt: number, generation: number): Promise<void> {
    const closed = () => this.closeRequested || generation !== this.lifecycleGeneration;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, WORKER_RESTART_BACKOFF_MS * 2 ** (attempt - 1));
      this.wakeRestartBackoff = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    this.wakeRestartBackoff = null;
    if (closed()) throw new Error('SQLiteDatabaseProxy closed');
    try {
      this.createWorker();
      await this.post('init', this.buildInitPayload(), INIT_REQUEST_TIMEOUT_MS);
    } catch (err) {
      if (closed()) throw new Error('SQLiteDatabaseProxy closed');
      // Counts as this attempt. Not retried, and no recovery runs.
      this.restartPromise = null;
      const down = new Error(
        `SQLite worker not running: restart ${attempt} of ${MAX_WORKER_RESTARTS} failed (${(err as Error).message}), so it was not retried`,
      );
      this.stayDown(down);
      throw down;
    }
    if (closed()) throw new Error('SQLiteDatabaseProxy closed');
    this.restartPromise = null;
    this.initialized = true;
    logger.main.info(`[SQLiteProxy] worker restarted (restart ${attempt} of ${MAX_WORKER_RESTARTS})`);
  }

  private stayDown(error: Error): void {
    logger.main.error(`[SQLiteProxy] ${error.message}`);
    this.downError = error;
    const rejected = Promise.reject(error);
    rejected.catch(() => {});
    this.initPromise = rejected;
  }

  /**
   * Every request goes through here. While a restart is under way it waits
   * for the new worker's `init`; once the proxy stays down it rejects with
   * the reason.
   */
  private send(type: WorkerRequestType, payload?: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.downError) return Promise.reject(this.downError);
    if (this.restartPromise) {
      return this.restartPromise.then(() => this.send(type, payload, timeoutMs));
    }
    return this.post(type, payload, timeoutMs);
  }

  private post(
    type: WorkerRequestType,
    payload?: unknown,
    timeoutMs = this.opts.requestTimeoutMs ?? 60_000,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const worker = this.worker;
      if (!worker) {
        reject(new Error('SQLite worker not running'));
        return;
      }
      const id = uuidv4();
      // Bus-drop guard. Worker may also enforce its own timeout (queryReadOnly
      // calls db.interrupt() when its bounded timer fires), so this is mostly
      // a safety net for "the worker thread died without exit". The timer is
      // cleared inline by the response handler — without that, every query
      // leaks a 60s timer into the wheel and CPU saturates under streaming
      // load.
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          // A UI deadline must not release ownership while the worker is
          // still copying or renaming. These operations settle on reply/exit.
          if (['migrationStart', 'migrationStartDryRun', 'migrationAdoptDryRun'].includes(type)) return;
          this.pending.delete(id);
          reject(new Error(`SQLite worker request '${type}' timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      if (SELF_MANAGED_REQUESTS.has(type)) this.selfManagedInFlight.set(id, type);
      worker.postMessage({ id, type, payload });
    });
  }

  /**
   * Route an event-shaped message from the worker.
   * Branches:
   *   - `log`: forward to the main-process logger.
   *   - `db:migration:*`: fan out to BrowserWindows on the matching IPC
   *     channel so the renderer sees the same payload it always has.
   *   - `db:migration:cutoverSuccess`: invoke the registered control hook and
   *     persist the backend flag (the worker side already renamed pglite-db/
   *     and ran the data copy).
   *   - `pgliteReadRequest`: run the SQL against the injected PGLite reader
   *     and post a `bridgeResponse` back to the worker.
   *   - `workerControlRequest`: run the requested action (e.g. close PGLite)
   *     via the injected control handler and post a `bridgeResponse` back.
   */
  private handleWorkerEvent(msg: {
    event: string;
    bridgeId?: string;
    payload: unknown;
  }): void {
    if (msg.event === 'log') {
      const { level, msg: line, meta } = msg.payload as {
        level: 'info' | 'warn' | 'error';
        msg: string;
        meta?: unknown;
      };
      if (level === 'error') logger.main.error(line, meta);
      else if (level === 'warn') logger.main.warn(line, meta);
      else logger.main.info(line, meta);
      return;
    }
    if (
      msg.event === 'db:migration:phase'
      || msg.event === 'db:migration:progress'
      || msg.event === 'db:migration:complete'
      || msg.event === 'db:migration:failed'
    ) {
      this.broadcastToWindows(msg.event, msg.payload);
      observeMigrationProgress(msg.event, msg.payload);
      // Main-side observer. The boot-time forced migration drives the splash
      // screen, which is a plain data-URL BrowserWindow with no preload — it
      // cannot receive an ipcRenderer message, so the broadcast above never
      // reaches it.
      if (this.migrationObserver) {
        try {
          this.migrationObserver(msg.event, msg.payload);
        } catch (err) {
          logger.main.warn('[SQLiteProxy] migration observer threw', err);
        }
      }
      return;
    }
    if (msg.event === MIGRATION_OUTCOME_EVENT) {
      // The single point at which a migration becomes analytics. The worker
      // returns a typed result and never names an event; the mapper decides
      // what is emitted and guarantees one terminal event per operation.
      emitMigrationOutcome(msg.payload as MigrationOutcome);
      return;
    }
    if (msg.event === 'db:migration:cutoverSuccess') {
      const info = msg.payload as { sqliteDir: string; pgliteMigratedDir: string };
      const hook = this.migrationControl?.onCutoverSuccess;
      if (hook) {
        Promise.resolve(hook(info)).catch((err) =>
          logger.main.warn('[SQLiteProxy] onCutoverSuccess hook threw', err),
        );
      }
      return;
    }
    if (msg.event === 'pgliteReadRequest') {
      if (!msg.bridgeId) return;
      const bridgeId = msg.bridgeId;
      const p = msg.payload as PgliteReadRequestPayload;
      const reader = this.pgliteReader;
      if (!reader) {
        this.respondToBridge(bridgeId, false, undefined, {
          message: 'No PGLite reader registered on SQLiteDatabaseProxy',
        });
        return;
      }
      reader
        .queryReadOnly(p.sql, p.params, p.timeoutMs)
        .then((result) => this.respondToBridge(bridgeId, true, result))
        .catch((err) =>
          this.respondToBridge(bridgeId, false, undefined, serializeBridgeError(err)),
        );
      return;
    }
    if (msg.event === 'workerControlRequest') {
      if (!msg.bridgeId) return;
      const bridgeId = msg.bridgeId;
      const p = msg.payload as WorkerControlRequestPayload;
      const handler = this.migrationControl;
      if (!handler) {
        this.respondToBridge(bridgeId, false, undefined, {
          message: 'No migration control handler registered on SQLiteDatabaseProxy',
        });
        return;
      }
      if (p.action === 'closePglite') {
        handler
          .closePglite()
          .then(() => this.respondToBridge(bridgeId, true, { ok: true }))
          .catch((err) =>
            this.respondToBridge(bridgeId, false, undefined, serializeBridgeError(err)),
          );
      } else {
        this.respondToBridge(bridgeId, false, undefined, {
          message: `Unknown worker control action: ${String(p.action)}`,
        });
      }
      return;
    }
  }

  /** Post a bridge response back to the worker. */
  private respondToBridge(
    bridgeId: string,
    success: boolean,
    data?: unknown,
    error?: SerializedError,
  ): void {
    if (!this.worker) return;
    this.worker.postMessage({ bridgeResponse: true, bridgeId, success, data, error });
  }

  /** Fan out to every live BrowserWindow. */
  private broadcastToWindows(channel: string, payload: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      try {
        win.webContents.send(channel, payload);
      } catch {
        // Window may have closed between the isDestroyed check and the send.
      }
    }
  }

  /**
   * Façade over the worker-hosted backup service. Every mutating operation is
   * an explicit worker request — those code paths are intentionally narrow.
   */
  private makeBackupFacade(): AppDatabaseBackupService {
    const self = this;
    return {
      async initialize() {
        // No-op; the worker initializes backup during 'init'.
      },
      async createBackup() {
        return self.createBackup();
      },
      async restoreFromBackup() {
        // The whole restore -- close, stage, verify, swap, reopen -- happens
        // inside the worker, because the live `SQLiteDatabase` the recovery
        // transaction has to close and reopen only exists there. This used to
        // return "not yet wired", which meant `SQLiteBackupService.restoreFromBackup()`
        // was implemented, tested, and unreachable from a shipped build: a
        // SQLite install with three healthy rolling backups had no path to any
        // of them.
        //
        // The same ceiling `createBackup` uses, for the same reason: a restore
        // stages a full copy and runs `integrity_check` over it, so the
        // default 60s request timeout would drop the pending entry and report
        // a restore that in fact completed as a failure.
        return self.send('restoreBackup', undefined, BACKUP_REQUEST_TIMEOUT_MS) as Promise<{
          success: boolean;
          error?: string;
          source?: string;
        }>;
      },
      hasBackups() {
        // Best-effort. Backup metadata lives in the worker, but the file
        // presence check we used historically only needs the directory.
        return false;
      },
      getBackupStatus() {
        // Synchronous accessor that callers (dashboard) hit per refresh. We
        // return null here; the renderer should fetch the status async via
        // the dashboardTableStats response which the worker bundles.
        return null;
      },
      async cleanupOldCorruptedBackups() {
        await self.send('cleanupBackups');
      },
    } as unknown as AppDatabaseBackupService;
  }
}
