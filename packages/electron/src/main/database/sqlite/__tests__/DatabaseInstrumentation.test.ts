// @vitest-environment node
/**
 * Pure-logic tests for DatabaseInstrumentation. No native binding; mock the
 * SQLite handle so this runs even when better-sqlite3 isn't installed.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DatabaseInstrumentation,
  SLOW_QUERY_PRUNE_EVERY,
  SLOW_QUERY_SHAPE_MAX_CHARS,
  extractCallSite,
  extractPrimaryTable,
  normalizeSql,
} from '../DatabaseInstrumentation';

describe('normalizeSql', () => {
  it('replaces numeric and string literals with ?', () => {
    expect(normalizeSql(`SELECT * FROM t WHERE id = 5 AND name = 'foo'`)).toBe(
      'select * from t where id = ? and name = ?',
    );
  });
  it('collapses whitespace and strips comments', () => {
    const sql = `SELECT *
      FROM t -- comment
      WHERE id = 5 /* block */ AND name = 'foo'`;
    expect(normalizeSql(sql)).toBe('select * from t where id = ? and name = ?');
  });
  it('replaces $N positional params', () => {
    expect(normalizeSql('SELECT * FROM t WHERE id = $1 AND name = $2')).toBe(
      'select * from t where id = ? and name = ?',
    );
  });
});

describe('extractPrimaryTable', () => {
  it('picks the table from a SELECT', () => {
    expect(extractPrimaryTable('SELECT * FROM ai_sessions WHERE id = ?')).toBe('ai_sessions');
  });
  it('picks the table from an UPDATE', () => {
    expect(extractPrimaryTable('UPDATE tracker_items SET data = ? WHERE id = ?')).toBe(
      'tracker_items',
    );
  });
  it('returns null for unknown shapes', () => {
    expect(extractPrimaryTable('VACUUM;')).toBeNull();
  });
});

describe('extractCallSite', () => {
  it('skips database-layer frames and returns the first app frame', () => {
    const stack = [
      'Error',
      '    at captureStack (/x/SQLiteDatabase.ts:12:1)',
      '    at SQLiteDatabase.runRead (/x/SQLiteDatabase.ts:300:1)',
      '    at DatabaseInstrumentation.beginInFlight (/x/DatabaseInstrumentation.ts:50:1)',
      '    at FooService.list (/x/services/FooService.ts:42:7)',
    ].join('\n');
    expect(extractCallSite(stack)).toContain('FooService.list');
  });
});

describe('DatabaseInstrumentation aggregation', () => {
  it('aggregates by query shape and reports p99', () => {
    const inst = new DatabaseInstrumentation({ sampleRate: 1 });
    for (let i = 0; i < 100; i++) {
      inst.recordQuery({
        sql: `SELECT * FROM ai_sessions WHERE id = ${i}`,
        kind: 'read',
        durationMs: i, // 0..99
      });
    }
    const snap = inst.getSnapshot();
    const sessions = snap.byShape.find((s) => s.shape.includes('ai_sessions'));
    expect(sessions).toBeDefined();
    expect(sessions!.count).toBe(100);
    // p99 ~ 99 (top of 0..99)
    expect(sessions!.p99).toBeGreaterThan(95);
    expect(snap.histogram.read.lt100ms).toBeGreaterThan(0);
  });

  it('always records slow queries even when sampleRate is 0', () => {
    const inst = new DatabaseInstrumentation({ sampleRate: 0, slowQueryThresholdMs: 50 });
    inst.recordQuery({
      sql: 'SELECT * FROM tracker_items',
      kind: 'read',
      durationMs: 100,
    });
    expect(inst.getSnapshot().byShape).toHaveLength(1);
  });

  it('drops non-slow queries when sampleRate is 0', () => {
    const inst = new DatabaseInstrumentation({ sampleRate: 0, slowQueryThresholdMs: 50 });
    inst.recordQuery({
      sql: 'SELECT * FROM tracker_items',
      kind: 'read',
      durationMs: 1,
    });
    expect(inst.getSnapshot().byShape).toHaveLength(0);
    // Histogram still gets the data point so totalQueries reflects reality.
    expect(inst.getSnapshot().totalQueries).toBe(1);
  });

  it('tracks in-flight queries until end()', () => {
    const inst = new DatabaseInstrumentation();
    const h1 = inst.beginInFlight('SELECT 1');
    const h2 = inst.beginInFlight('SELECT 2');
    expect(inst.getSnapshot().inFlight).toHaveLength(2);
    h1.end();
    expect(inst.getSnapshot().inFlight).toHaveLength(1);
    h2.end();
    expect(inst.getSnapshot().inFlight).toHaveLength(0);
  });

  it('records coordinator batch and chunk metrics', () => {
    const inst = new DatabaseInstrumentation();
    inst.recordCoordinatorBatch({ batchSize: 4, durationMs: 2, fsynced: true });
    inst.recordCoordinatorBatch({ batchSize: 6, durationMs: 3, fsynced: true });
    inst.recordCoordinatorChunk({ name: 'fts-rebuild', durationMs: 5, chunkIndex: 0 });
    inst.recordCoordinatorChunk({ name: 'fts-rebuild', durationMs: 5, chunkIndex: 1 });
    inst.recordSlowBgChunk({ name: 'fts-rebuild', durationMs: 80, chunkIndex: 2 });
    const c = inst.getSnapshot().coordinator;
    expect(c.batches).toBe(2);
    expect(c.fsyncs).toBe(2);
    expect(c.avgBatchSize).toBe(5);
    expect(c.bgOps).toBe(1);
    expect(c.slowBgChunks).toBe(1);
  });

  it('reset() clears rolling state but leaves slow-query persistence alone', () => {
    const inst = new DatabaseInstrumentation();
    inst.recordQuery({ sql: 'SELECT 1', kind: 'read', durationMs: 1 });
    inst.reset();
    expect(inst.getSnapshot().byShape).toHaveLength(0);
    expect(inst.getSnapshot().totalQueries).toBe(0);
  });
});

describe('DatabaseInstrumentation slow-query persistence', () => {
  function bindFake(inst: DatabaseInstrumentation) {
    const insert = vi.fn();
    const prune = vi.fn();
    const db = {
      exec: vi.fn(),
      pragma: vi.fn(() => 0),
      prepare: vi.fn((sql: string) => ({ run: sql.includes('DELETE') ? prune : insert })),
    };
    inst.bind(db as never);
    return { insert, prune };
  }

  it('prunes deterministically to the 2,000-row default cap, not on a coin flip', () => {
    const inst = new DatabaseInstrumentation({ sampleRate: 0, slowQueryThresholdMs: 10 });
    const { insert, prune } = bindFake(inst);
    const inserts = SLOW_QUERY_PRUNE_EVERY * 3;
    for (let i = 0; i < inserts; i++) {
      inst.recordQuery({ sql: `SELECT * FROM t WHERE id = ${i}`, kind: 'read', durationMs: 20 });
    }
    expect(insert).toHaveBeenCalledTimes(inserts);
    // First insert of the session, then once every SLOW_QUERY_PRUNE_EVERY.
    expect(prune).toHaveBeenCalledTimes(3);
    expect(prune).toHaveBeenCalledWith(2000);
  });

  it('caps the stored shape text', () => {
    const inst = new DatabaseInstrumentation({ sampleRate: 0, slowQueryThresholdMs: 10 });
    const { insert } = bindFake(inst);
    const columns = Array.from({ length: 2000 }, (_, i) => `col_${i}`).join(', ');
    inst.recordQuery({ sql: `SELECT ${columns} FROM t`, kind: 'read', durationMs: 20 });
    const row = insert.mock.calls[0][0] as { shape: string };
    expect(row.shape.length).toBeLessThanOrEqual(SLOW_QUERY_SHAPE_MAX_CHARS + 3);
    expect(row.shape.startsWith('select col_0')).toBe(true);
  });
});
