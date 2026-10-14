// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import {
  createSharedDocumentRouter,
  parseSharedDocumentDeepLink,
  parseSharedFolderDeepLink,
  type SharedDocumentRoutingDeps,
} from '../sharedDocumentRouting';
import type { DeepLinkNotice } from '../../../shared/deepLinkNotices';

interface FakeWindow {
  sent: Array<[string, unknown]>;
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  focus(): void;
  webContents: { send(channel: string, payload: unknown): void };
}

function fakeWindow(): FakeWindow {
  const sent: Array<[string, unknown]> = [];
  return {
    sent,
    isDestroyed: () => false,
    isMinimized: () => false,
    restore: () => {},
    focus: () => {},
    webContents: { send: (channel, payload) => sent.push([channel, payload]) },
  };
}

/** One org, two team projects: `/work/a` is project A, `/work/b` is project B. */
const TEAMS: Record<string, { orgId: string; teamProjectId: string | null }> = {
  '/work/a': { orgId: 'org-1', teamProjectId: 'tp-a' },
  '/work/b': { orgId: 'org-1', teamProjectId: 'tp-b' },
  '/work/other': { orgId: 'org-2', teamProjectId: 'tp-x' },
};

function setup(overrides: Partial<SharedDocumentRoutingDeps> & { windows?: Record<string, FakeWindow> } = {}) {
  const windows = overrides.windows ?? {};
  const notices: DeepLinkNotice[] = [];
  const created: string[] = [];
  const findTeamForWorkspace = vi.fn(async (path: string) => TEAMS[path] ?? null);
  const deps: SharedDocumentRoutingDeps = {
    isAuthenticated: () => true,
    openWorkspacePaths: () => ['/work/a'],
    recentWorkspacePaths: () => ['/work/a', '/work/other', '/work/b'],
    findTeamForWorkspace,
    findWindowByWorkspace: (path) => windows[path] ?? null,
    createWindowForWorkspace: (path) => created.push(path),
    notify: (notice) => notices.push(notice),
    log: { info: () => {}, warn: () => {} },
    ...overrides,
  };
  return { router: createSharedDocumentRouter(deps), notices, created, windows, findTeamForWorkspace };
}

describe('shared document deep-link routing', () => {
  it('opens a link for project B in project B, even when project A of the same org is found first', async () => {
    const windowA = fakeWindow();
    const { router, created } = setup({ windows: { '/work/a': windowA } });

    const routed = await router.openSharedDocument({ documentId: 'doc-1', orgId: 'org-1', projectId: 'tp-b', anchor: {} });

    expect(routed).toBe(true);
    expect(created).toEqual(['/work/b']);
    expect(windowA.sent).toEqual([]);
    expect(router.consumePendingSharedDocument('/work/a')).toBeNull();
    expect(router.consumePendingSharedDocument('/work/b')).toEqual({
      documentId: 'doc-1', orgId: 'org-1', projectId: 'tp-b', workspacePath: '/work/b',
    });
  });

  it('prefers an open window of the right project over opening a recent one', async () => {
    const windowB = fakeWindow();
    const { router, created } = setup({
      windows: { '/work/b': windowB },
      openWorkspacePaths: () => ['/work/a', '/work/b'],
    });

    await router.openSharedDocument({ documentId: 'doc-1', orgId: 'org-1', projectId: 'tp-b', anchor: { threadId: 't-1' } });

    expect(created).toEqual([]);
    // A bare signal: the link itself is read only through the consuming queue,
    // so it is applied once and a later drain cannot replay it.
    expect(windowB.sent).toEqual([['deep-link:shared-document-available', { workspacePath: '/work/b' }]]);
    expect(router.consumePendingSharedDocument('/work/b')).toEqual({
      documentId: 'doc-1', orgId: 'org-1', projectId: 'tp-b', threadId: 't-1', workspacePath: '/work/b',
    });
    expect(router.consumePendingSharedDocument('/work/b')).toBeNull();
  });

  it('falls back to any workspace of the org when none is on the link project', async () => {
    const windowA = fakeWindow();
    const { router } = setup({ windows: { '/work/a': windowA }, recentWorkspacePaths: () => ['/work/a'] });

    await router.openSharedDocument({ documentId: 'doc-1', orgId: 'org-1', projectId: 'tp-gone', anchor: {} });

    expect(windowA.sent.map(([channel]) => channel)).toEqual(['deep-link:shared-document-available']);
  });

  it('routes a link without a project by org only, stopping at the first match', async () => {
    const windowA = fakeWindow();
    const { router, findTeamForWorkspace } = setup({ windows: { '/work/a': windowA } });

    await router.openSharedDocument({ documentId: 'doc-1', orgId: 'org-1', projectId: null, anchor: {} });

    expect(windowA.sent).toHaveLength(1);
    expect(findTeamForWorkspace).toHaveBeenCalledTimes(1);
  });

  it('reports a link it cannot route instead of dropping it', async () => {
    const signedOut = setup({ isAuthenticated: () => false });
    expect(await signedOut.router.openSharedDocument({ documentId: 'doc-1', orgId: 'org-1', projectId: null, anchor: {} })).toBe(false);
    expect(signedOut.notices).toEqual([{ kind: 'shared-document', reason: 'not-authenticated', orgId: 'org-1', documentId: 'doc-1' }]);

    const noWorkspace = setup();
    await noWorkspace.router.openSharedFolder({ folderId: 'f-1', orgId: 'org-9', projectId: null });
    expect(noWorkspace.notices).toEqual([{ kind: 'shared-folder', reason: 'no-workspace', orgId: 'org-9', folderId: 'f-1' }]);
  });

  it('routes folder links by project too', async () => {
    const { router, created } = setup();

    await router.openSharedFolder({ folderId: 'f-1', orgId: 'org-1', projectId: 'tp-b' });

    expect(created).toEqual(['/work/b']);
    expect(router.consumePendingSharedFolder('/work/b')).toEqual({
      folderId: 'f-1', orgId: 'org-1', projectId: 'tp-b', workspacePath: '/work/b',
    });
  });
});

describe('shared document deep-link parsing', () => {
  it('reads the document, org, optional project and anchor', () => {
    expect(parseSharedDocumentDeepLink('nimbalyst://doc/doc%201?orgId=org-1&projectId=tp-b&threadId=t-1')).toEqual({
      documentId: 'doc 1', orgId: 'org-1', projectId: 'tp-b', anchor: { threadId: 't-1' },
    });
    expect(parseSharedDocumentDeepLink('nimbalyst://doc/doc-1?orgId=org-1')).toEqual({
      documentId: 'doc-1', orgId: 'org-1', projectId: null, anchor: {},
    });
  });

  it('rejects incomplete or malformed links', () => {
    expect(parseSharedDocumentDeepLink('nimbalyst://doc/doc-1')).toBeNull();
    expect(parseSharedDocumentDeepLink('nimbalyst://doc/?orgId=org-1')).toBeNull();
    expect(parseSharedDocumentDeepLink('nimbalyst://doc/%E0%A4%A?orgId=org-1')).toBeNull();
    expect(parseSharedDocumentDeepLink('nimbalyst://folder/f-1?orgId=org-1')).toBeNull();
  });

  it('reads folder links', () => {
    expect(parseSharedFolderDeepLink('nimbalyst://folder/f-1?orgId=org-1&projectId=tp-b')).toEqual({
      folderId: 'f-1', orgId: 'org-1', projectId: 'tp-b',
    });
    expect(parseSharedFolderDeepLink('nimbalyst://folder/f-1')).toBeNull();
  });
});
