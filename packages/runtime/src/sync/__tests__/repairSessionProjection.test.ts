// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { repairSessionProjection, type ProjectionRepairCheckpoints } from '../repairSessionProjection';
import type { AgentMessage } from '../../ai/server/types';

it('resumes only acknowledged source rows and refuses unavailable or cross-session sources', async () => {
  const rows = [1, 2].map(id => ({ id, sessionId: 's', content: 'original reply'.repeat(1500), createdAt: new Date(1), source: 'user', direction: 'input' })) as AgentMessage[];
  let stored: Awaited<ReturnType<ProjectionRepairCheckpoints['load']>>;
  const checkpoints: ProjectionRepairCheckpoints = { load: async () => stored, save: async (_session, value) => { stored = structuredClone(value); } };
  const sendSessionMessages = vi.fn().mockResolvedValueOnce({ published: true }).mockResolvedValueOnce({ published: false, retryable: true, reason: 'lost acknowledgement' });
  expect(await repairSessionProjection('s', rows, { sendSessionMessages }, checkpoints, 1)).toMatchObject({ published: false, repaired: 1 });
  expect(stored?.completed).toHaveLength(1);
  sendSessionMessages.mockResolvedValue({ published: true });
  expect(await repairSessionProjection('s', rows, { sendSessionMessages }, checkpoints, 1)).toEqual({ published: true, repaired: 1 });
  expect(sendSessionMessages.mock.calls[2][1]).toEqual([rows[1]]);
  expect(await repairSessionProjection('s', rows, { sendSessionMessages }, checkpoints, 1)).toEqual({ published: true, repaired: 0 });
  rows[0].content += ' revised';
  expect(await repairSessionProjection('s', rows, { sendSessionMessages }, checkpoints, 1)).toEqual({ published: true, repaired: 1 });
  expect(await repairSessionProjection('s', [], { sendSessionMessages }, checkpoints, 1)).toMatchObject({ published: false, repaired: 0 });
  await expect(repairSessionProjection('other', rows, { sendSessionMessages }, checkpoints, 1)).rejects.toThrow(/another session/);
});

it('persists a local checkpoint across host restart without retaining source text', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { projectionRepairCheckpointFile } = await import('../projectionRepairCheckpointFile');
  const directory = await mkdtemp(join(tmpdir(), 'github-1711-checkpoint-'));
  try {
    const file = join(directory, 'repair.json');
    const checkpoint = projectionRepairCheckpointFile(file);
    expect(await checkpoint.load('s')).toBeUndefined();
    await checkpoint.save('s', { version: 1, completed: ['a'.repeat(64)] });
    expect(await projectionRepairCheckpointFile(file).load('s')).toEqual({ version: 1, completed: ['a'.repeat(64)] });
    expect(Object.keys(JSON.parse(await readFile(file, 'utf8'))).sort()).toEqual(['completed', 'sessionId', 'version']);
    await expect(checkpoint.load('another-session')).rejects.toThrow(/mismatched/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
