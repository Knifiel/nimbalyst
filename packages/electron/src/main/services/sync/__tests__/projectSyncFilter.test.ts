// @vitest-environment node
import { expect, it, vi } from 'vitest';

vi.mock('../../../utils/store', () => ({ store: { get: vi.fn() } }));
vi.mock('../../../utils/workspaceDetection', () => ({ resolveProjectPath: vi.fn((path: string) => path) }));

import { createLiveSessionSyncFilter, createTranscriptSyncDisabledPredicate } from '../projectSyncFilter';
import { createTranscriptBackfill } from '../transcriptBackfill';

it('uploads only sessions in enabled projects, worktrees included, and follows Settings changes (NIM-7479)', async () => {
  const workspaces: Record<string, string> = { a: '/repo', b: '/other', wt: '/repo_worktrees/fix' };
  const getWorkspaceId = vi.fn(async (id: string) => workspaces[id]);
  let enabled = ['/repo'];
  const resolve = vi.fn((path: string) => path.replace(/_worktrees\/.*$/, ''));
  const allowed = createLiveSessionSyncFilter(getWorkspaceId, () => enabled, resolve);

  expect(await allowed('a')).toBe(true);
  expect(await allowed('wt')).toBe(true);
  expect(await allowed('b')).toBe(false);
  expect(await allowed('missing')).toBe(false);
  enabled = ['/other'];
  expect(await allowed('b')).toBe(true);
  expect(await allowed('a')).toBe(false);
  // One session lookup per session and one path resolution per workspace.
  await allowed('wt');
  expect(getWorkspaceId).toHaveBeenCalledTimes(4);
  expect(resolve.mock.calls.filter(([path]) => path === '/repo_worktrees/fix')).toHaveLength(1);
});

it('marks transcripts withheld for projects not enabled, held right after enabling, and owed to a session (NIM-7545)', () => {
  let persisted: unknown;
  const storage = { read: () => persisted, write: (state: unknown) => { persisted = structuredClone(state); } };
  const resolve = (path: string) => path.replace(/_worktrees\/.*$/, '');
  let enabled: string[] = [];
  const backfill = createTranscriptBackfill(storage, resolve);
  const isDisabled = createTranscriptSyncDisabledPredicate(backfill, () => enabled, resolve);
  expect(isDisabled('/repo', 's1')).toBe(true);

  // Enabling holds the mark until a reconcile has read the server, across a restart.
  backfill.holdProjects(['/repo']);
  enabled = ['/repo'];
  const afterRestart = createTranscriptSyncDisabledPredicate(createTranscriptBackfill(storage, resolve), () => enabled, resolve);
  expect(afterRestart('/repo', 's1')).toBe(true);
  expect(afterRestart('/repo_worktrees/fix', 's2')).toBe(true);

  // That reconcile found s1 owing its history and released the hold.
  backfill.recordReconcile(['s1'], backfill.heldProjects(), () => true);
  expect(isDisabled('/repo', 's1')).toBe(true);
  expect(isDisabled('/repo', 's2')).toBe(false);
  expect(backfill.settle('s1')).toBe(true);
  expect(isDisabled('/repo', 's1')).toBe(false);

  // A write that fails moves nothing.
  const failing = createTranscriptBackfill({ read: () => persisted, write: () => { throw new Error('disk full'); } }, resolve);
  expect(() => failing.holdProjects(['/other'])).toThrow('disk full');
  expect(failing.heldProjects().has('/other')).toBe(false);

  enabled = [];
  expect(isDisabled('/repo', 's2')).toBe(true);
});
