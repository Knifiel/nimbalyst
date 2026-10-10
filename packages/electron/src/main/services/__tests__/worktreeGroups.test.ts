// @vitest-environment node
/**
 * Worktree groups: an anchor worktree whose folder holds other repositories'
 * worktrees (its members). What must never happen is a member's checkout --
 * and the uncommitted work in it -- being deleted with the anchor's folder, or
 * hidden behind an anchor the UI calls clean. These run on both database
 * engines, through the real migration (SQLite) and the real worker.js mirror
 * block (PGLite), each opened twice as two launches would.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PGlite } from '@electric-sql/pglite';
import { SQLiteDatabase } from '../../database/sqlite/SQLiteDatabase';
import type { WorktreeStatus } from '../GitWorktreeService';
import { createWorktreeStore, type Worktree } from '../WorktreeStore';
import { createWorktreeArchiveCleanup, reconcileArchivedGroupMembers } from '../worktreeArchiveCleanup';
import { combineGroupStatus } from '../worktreeGroups';

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() }, BrowserWindow: { getAllWindows: () => [] } }));

const clean: WorktreeStatus = {
  hasUncommittedChanges: false, modifiedFileCount: 0, commitsAhead: 0, commitsBehind: 0, isMerged: true,
};

describe('combineGroupStatus', () => {
  const member = (status: WorktreeStatus | null) => ({ worktreeId: 'm', path: '/t/api', repoPath: '/api', status });

  it('is dirty and unmerged when any member is, though the anchor is neither', () => {
    const combined = combineGroupStatus(clean, [
      member(clean),
      member({ ...clean, hasUncommittedChanges: true, modifiedFileCount: 2, isMerged: false, commitsAhead: 3 }),
    ]);
    expect(combined).toMatchObject({
      hasUncommittedChanges: true, modifiedFileCount: 2, isMerged: false, commitsAhead: 3, uniqueCommitsAhead: 3,
    });
    expect(combined.members).toHaveLength(2);
  });

  it('treats a member git could not read as dirty and unmerged', () => {
    expect(combineGroupStatus(clean, [member(null)])).toMatchObject({ hasUncommittedChanges: true, isMerged: false });
  });
});

type Db = { query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }> };

/** The worker.js block that mirrors a SQLite migration, as PGLite runs it on every launch */
function mirrorDdl(version: string): string {
  const source = fs.readFileSync(path.resolve(__dirname, '..', '..', 'database', 'worker.js'), 'utf8');
  const start = source.indexOf(`Mirror of SQLite migration ${version}`);
  const ddl = source.slice(start).match(/exec\(`([\s\S]*?)`\)/);
  if (start < 0 || !ddl) throw new Error(`${version} mirror block not found in worker.js`);
  return ddl[1];
}

/** Opens the database the way a launch does; a second call on the same `dir` is the next launch. */
async function launchDatabase(engine: 'pglite' | 'sqlite', dir: string, pglite?: PGlite): Promise<{ db: Db; close: () => Promise<void> }> {
  if (engine === 'sqlite') {
    const sqlite = new SQLiteDatabase({
      dbDir: path.join(dir, 'sqlite-db'),
      schemaDir: path.resolve(__dirname, '../../database/sqlite/schemas'),
      log: () => {},
    });
    await sqlite.initialize();
    return { db: sqlite, close: () => sqlite.close() };
  }
  const db = pglite!;
  // The table as earlier migrations left it, then the group block as worker.js runs it
  await db.exec(`
    CREATE TABLE IF NOT EXISTS worktrees (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL, display_name TEXT,
      path TEXT NOT NULL, branch TEXT NOT NULL, base_branch TEXT, source_folder_path TEXT,
      is_pinned BOOLEAN DEFAULT FALSE, is_archived BOOLEAN DEFAULT FALSE,
      pr_number INTEGER, pr_remote TEXT, pr_url TEXT,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await db.exec(mirrorDdl('0053'));
  return { db, close: async () => {} };
}

describe.each(['pglite', 'sqlite'] as const)('worktree groups (%s)', (engine) => {
  let tmp: string;
  let pglite: PGlite | undefined;
  let db: Db;
  let close: () => Promise<void>;

  const anchorPath = () => path.join(tmp, 'work_worktrees', 'task');
  const row = (id: string, folder: string, extra: Partial<Worktree> = {}): Worktree => ({
    id,
    name: id,
    path: folder,
    branch: `worktree/${id}`,
    baseBranch: 'main',
    projectPath: path.join(tmp, 'work'),
    createdAt: Date.now(),
    ...extra,
  });

  /** An anchor holding a shallow and a nested member, plus an ordinary worktree */
  async function seedGroup() {
    const store = createWorktreeStore(db);
    await store.create(row('anchor', anchorPath(), { groupId: 'anchor' }));
    await store.create(row('api', path.join(anchorPath(), 'api'), { groupId: 'anchor', sourceFolderPath: path.join(tmp, 'work', 'api') }));
    await store.create(row('web', path.join(anchorPath(), 'apps', 'web'), { groupId: 'anchor', sourceFolderPath: path.join(tmp, 'work', 'web') }));
    await store.create(row('plain', path.join(tmp, 'work_worktrees', 'plain')));
    return store;
  }

  beforeEach(async () => {
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nim-worktree-groups-')));
    pglite = engine === 'pglite' ? new PGlite() : undefined;
    // First launch migrates; the second must find nothing left to do
    const first = await launchDatabase(engine, tmp, pglite);
    if (engine === 'sqlite') await first.close();
    ({ db, close } = await launchDatabase(engine, tmp, pglite));
  }, 30_000);

  afterEach(async () => {
    await close();
    await pglite?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('lists a group as its anchor, and refuses to drop the anchor row while members remain', async () => {
    const store = await seedGroup();

    expect((await store.list(path.join(tmp, 'work'))).map(w => w.id).sort()).toEqual(['anchor', 'plain']);
    expect((await store.listGroupMembers('anchor')).map(w => w.id)).toEqual(['web', 'api']);
    expect((await store.getByPath(path.join(anchorPath(), 'api')))?.groupId).toBe('anchor');
    expect(await store.getAllPaths()).toHaveLength(4);

    await expect(store.delete('anchor')).rejects.toThrow(/still has member/);
    await store.delete('web');
    await store.delete('api');
    await store.delete('anchor');
    expect(await store.get('anchor')).toBeNull();
  });

  it('removes members deepest first through their own repositories, then the anchor', async () => {
    const store = await seedGroup();
    const removed: Array<[string, string]> = [];
    const cleanup = createWorktreeArchiveCleanup({
      deleteWorktree: async (worktreePath, repoPath) => {
        removed.push([path.relative(tmp, worktreePath), path.relative(tmp, repoPath)]);
      },
      worktreeStore: store,
      superLoopStore: { getLoopByWorktreeId: async () => null, updateLoop: async () => null },
      archiveQueue: { updateTaskStatus: () => {} },
      unarchiveSession: async () => {},
      pathExists: () => true,
    });

    await cleanup((await store.get('anchor'))!, []);

    expect(removed).toEqual([
      ['work_worktrees/task/apps/web', 'work/web'],
      ['work_worktrees/task/api', 'work/api'],
      ['work_worktrees/task', 'work'],
    ]);
    expect((await store.listGroupMembers('anchor')).every(member => member.isArchived)).toBe(true);
  });

  it('stops before the anchor when a member cannot be removed, and shows the sessions again', async () => {
    const store = await seedGroup();
    const removed: string[] = [];
    const unarchived: string[] = [];
    const cleanup = createWorktreeArchiveCleanup({
      deleteWorktree: async (worktreePath) => {
        if (worktreePath.endsWith('api')) throw new Error('worktree is locked');
        removed.push(path.relative(tmp, worktreePath));
      },
      worktreeStore: store,
      superLoopStore: { getLoopByWorktreeId: async () => null, updateLoop: async () => null },
      archiveQueue: { updateTaskStatus: () => {} },
      unarchiveSession: async (sessionId) => { unarchived.push(sessionId); },
      pathExists: () => true,
    });

    await expect(cleanup((await store.get('anchor'))!, ['s-1'])).rejects.toThrow('worktree is locked');

    expect(removed).toEqual(['work_worktrees/task/apps/web']);
    expect(Boolean((await store.get('anchor'))?.isArchived)).toBe(false);
    expect(unarchived).toEqual(['s-1']);
  });

  it('archives the gone members of an archived anchor at startup and leaves the ones on disk, launch after launch', async () => {
    const store = await seedGroup();
    await store.updateArchived('anchor', true);
    const onDisk = new Set([path.join(anchorPath(), 'apps', 'web')]);

    for (const _launch of [1, 2]) {
      await reconcileArchivedGroupMembers(db, store, (p) => onDisk.has(p));
    }

    const members = Object.fromEntries((await store.listGroupMembers('anchor')).map(m => [m.id, Boolean(m.isArchived)]));
    expect(members).toEqual({ api: true, web: false });
  });
});
