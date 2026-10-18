// @vitest-environment node
/**
 * Fork-only migrations (Knifiel/nimbalyst integration builds). They are
 * numbered from 1001 so upstream's sequence never reaches them, and a database
 * from a fork build that recorded worktree_groups as version 53 is relabelled
 * so upstream's own 53 still runs. Kept out of MigrationRunner.test.ts so
 * upstream changes to that file merge cleanly.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { getForkMigrations, getMigrations } from '../MigrationRunner';
import { SQLiteDatabase } from '../SQLiteDatabase';

const SCHEMA_DIR = path.resolve(__dirname, '..', 'schemas');
const LAST_UPSTREAM_VERSION_IN_LEGACY_FORK_BUILDS = 52;

function ledger(db: SqliteDatabase): Array<{ version: number; name: string }> {
  return db.prepare('SELECT version, name FROM _migrations ORDER BY version').all() as Array<{ version: number; name: string }>;
}

function allMigrationVersions(): number[] {
  return getMigrations(SCHEMA_DIR).map((m) => m.version).sort((a, b) => a - b);
}

/** A database as fork builds up to 62d5d957b left it: upstream 1-52, then worktree_groups recorded as 53. */
function writeLegacyForkDatabase(dbDir: string): void {
  fs.mkdirSync(dbDir, { recursive: true });
  const db = new Database(path.join(dbDir, 'nimbalyst.sqlite'));
  try {
    db.exec(`
      CREATE TABLE _migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    `);
    const record = db.prepare('INSERT INTO _migrations (version, name) VALUES (?, ?)');
    for (const m of getMigrations(SCHEMA_DIR)) {
      if (m.version > LAST_UPSTREAM_VERSION_IN_LEGACY_FORK_BUILDS) continue;
      db.exec(fs.readFileSync(m.sqlFile!, 'utf-8'));
      record.run(m.version, m.name);
    }
    db.exec(fs.readFileSync(path.join(SCHEMA_DIR, '1001_worktree_groups.sql'), 'utf-8'));
    record.run(53, 'worktree_groups');
    db.prepare(
      `INSERT INTO worktrees (id, workspace_id, name, path, branch, group_id) VALUES ('wt-1', '/ws', 'task', '/ws_worktrees/task', 'worktree/task', 'wt-1')`,
    ).run();
  } finally {
    db.close();
  }
}

describe('fork migrations', () => {
  let tmp: string;
  let dbDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-fork-mig-'));
    dbDir = path.join(tmp, 'sqlite-db');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function launch<T>(inspect: (db: SqliteDatabase) => T): Promise<T> {
    const sqlite = new SQLiteDatabase({ dbDir, schemaDir: SCHEMA_DIR, sampleRate: 0 });
    try {
      await sqlite.initialize();
      return inspect(sqlite.getRawHandle()!);
    } finally {
      await sqlite.close();
    }
  }

  it('moves a legacy worktree_groups row off upstream version 53 without rerunning it, across two launches', async () => {
    writeLegacyForkDatabase(dbDir);

    for (let run = 0; run < 2; run++) {
      const state = await launch((db) => ({
        ledger: ledger(db),
        groupIdColumns: (db.prepare('PRAGMA table_info(worktrees)').all() as Array<{ name: string }>)
          .filter((c) => c.name === 'group_id').length,
        groups: db.prepare('SELECT id, group_id FROM worktrees').all(),
      }));
      // Every migration is recorded once, including upstream's own 53 and later.
      expect(state.ledger.map((r) => r.version)).toEqual(allMigrationVersions());
      expect(state.ledger.filter((r) => r.name === 'worktree_groups')).toEqual([{ version: 1001, name: 'worktree_groups' }]);
      expect(state.groupIdColumns).toBe(1);
      expect(state.groups).toEqual([{ id: 'wt-1', group_id: 'wt-1' }]);
    }
  });

  it('records worktree_groups as 1001 on a fresh database', async () => {
    const state = await launch((db) => ({
      ledger: ledger(db),
      columns: (db.prepare('PRAGMA table_info(worktrees)').all() as Array<{ name: string }>).map((c) => c.name),
    }));
    expect(state.ledger.map((r) => r.version)).toEqual(allMigrationVersions());
    expect(state.ledger.filter((r) => r.name === 'worktree_groups')).toEqual([{ version: 1001, name: 'worktree_groups' }]);
    expect(state.columns).toContain('group_id');
  });

  it('keeps fork versions above every upstream version', () => {
    const fork = getForkMigrations(SCHEMA_DIR);
    const forkVersions = new Set(fork.map((m) => m.version));
    const upstream = getMigrations(SCHEMA_DIR).filter((m) => !forkVersions.has(m.version));
    expect(fork.every((m) => m.version >= 1001)).toBe(true);
    expect(upstream.every((m) => m.version < 1001)).toBe(true);
  });
});
