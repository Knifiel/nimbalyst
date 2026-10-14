// @vitest-environment node
import { expect, it, vi } from 'vitest';

vi.mock('../../../utils/store', () => ({ store: { get: vi.fn() } }));
vi.mock('../../../utils/workspaceDetection', () => ({ resolveProjectPath: vi.fn((path: string) => path) }));

import { createLiveSessionSyncFilter } from '../projectSyncFilter';

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
