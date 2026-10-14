import { readFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProjectionRepairCheckpoints } from './repairSessionProjection';

/** Node host adapter for an explicitly selected repair. Use one file per session. */
export function projectionRepairCheckpointFile(path: string): ProjectionRepairCheckpoints {
  return {
    async load(sessionId) {
      let raw: string;
      try { raw = await readFile(path, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
      const value = JSON.parse(raw);
      if (value.sessionId !== sessionId || !Number.isInteger(value.version) || !Array.isArray(value.completed)
        || value.completed.some((entry: unknown) => typeof entry !== 'string' || !/^[a-f0-9]{64}$/.test(entry))) {
        throw new Error('Invalid or mismatched transcript repair checkpoint');
      }
      return { version: value.version, completed: value.completed as string[] };
    },
    async save(sessionId, value) {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify({ sessionId, ...value }), 'utf8'); await file.sync(); }
        finally { await file.close(); }
        await rename(temporary, path);
      } finally { await unlink(temporary).catch(() => {}); }
    },
  };
}
