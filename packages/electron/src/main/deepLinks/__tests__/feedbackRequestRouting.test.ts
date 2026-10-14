// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeepLinkNoticeQueue } from '../deepLinkNotices';
import { createFeedbackRequestRouter, type FeedbackRequestRoutingDeps } from '../feedbackRequestRouting';
import {
  clearPendingOrgFeedbackLinks,
  consumePendingOrgFeedbackLink,
} from '../../services/PendingOrgFeedbackLinks';
import type { DeepLinkNotice } from '../../../shared/deepLinkNotices';

function fakeWindow() {
  const sent: Array<[string, unknown?]> = [];
  return {
    sent,
    isDestroyed: () => false,
    isMinimized: () => false,
    restore: () => {},
    focus: () => {},
    webContents: { send: (channel: string, payload?: unknown) => { sent.push(payload === undefined ? [channel] : [channel, payload]); } },
  };
}

describe('deep-link notices', () => {
  it('holds a notice for the next window to drain when no window is open, opening the Project Manager', () => {
    const openProjectManager = vi.fn();
    const queue = createDeepLinkNoticeQueue({ targetWindow: () => null, openProjectManager });
    const notice: DeepLinkNotice = { kind: 'shared-document', reason: 'no-workspace', orgId: 'org-1', documentId: 'doc-1' };

    queue.deliver(notice);

    expect(openProjectManager).toHaveBeenCalledTimes(1);
    expect(queue.consume()).toEqual([notice]);
    expect(queue.consume()).toEqual([]);
  });

  it('nudges the target window, which reads the notice through the queue', () => {
    const win = fakeWindow();
    const openProjectManager = vi.fn();
    const queue = createDeepLinkNoticeQueue({ targetWindow: () => win, openProjectManager });

    queue.deliver({ kind: 'feedback-request', reason: 'not-authenticated', orgId: 'org-1', requestId: 'r-1' });

    expect(win.sent).toEqual([['deep-link:notice-available']]);
    expect(openProjectManager).not.toHaveBeenCalled();
    expect(queue.consume()).toHaveLength(1);
  });
});

describe('feedback request deep-link routing', () => {
  let notices: DeepLinkNotice[];
  let openedOrgWindows: unknown[];

  beforeEach(() => {
    notices = [];
    openedOrgWindows = [];
    clearPendingOrgFeedbackLinks();
  });

  function setup(overrides: Partial<FeedbackRequestRoutingDeps> = {}) {
    const deps: FeedbackRequestRoutingDeps = {
      isAuthenticated: () => true,
      focusedWorkspace: () => null,
      findTeamForWorkspace: async () => null,
      findWorkspaceForOrgId: async () => null,
      openOrganizationWindow: (target) => openedOrgWindows.push(target),
      notify: (notice) => notices.push(notice),
      log: { info: () => {}, warn: () => {} },
      ...overrides,
    };
    return createFeedbackRequestRouter(deps);
  }

  it('tells a signed-out user to sign in instead of doing nothing', async () => {
    const router = setup({ isAuthenticated: () => false });

    expect(await router.openFeedbackRequest({ requestId: 'r-1', orgId: 'org-1' })).toBe(false);
    expect(notices).toEqual([{ kind: 'feedback-request', reason: 'not-authenticated', orgId: 'org-1', requestId: 'r-1' }]);
  });

  it('says no project is open for the org instead of doing nothing', async () => {
    const router = setup();

    expect(await router.openFeedbackRequest({ requestId: 'r-1', orgId: 'org-1' })).toBe(false);
    expect(notices).toEqual([{ kind: 'feedback-request', reason: 'no-workspace', orgId: 'org-1', requestId: 'r-1' }]);
  });

  it('stays quiet when the caller has its own fallback', async () => {
    const router = setup();

    expect(await router.openFeedbackRequest({ requestId: 'r-1', orgId: 'org-1' }, { reportFailure: false })).toBe(false);
    expect(notices).toEqual([]);
  });

  it('opens the focused project Org mode when the project belongs to the org', async () => {
    const win = fakeWindow();
    const router = setup({
      focusedWorkspace: () => ({ window: win, workspacePath: '/work/a' }),
      findTeamForWorkspace: async () => ({ orgId: 'org-1' }),
    });

    expect(await router.openFeedbackRequest({ requestId: 'r-1', orgId: 'org-1' })).toBe(true);
    expect(win.sent).toEqual([['deep-link:open-org-feedback-request', { requestId: 'r-1', orgId: 'org-1', workspacePath: '/work/a' }]]);
    expect(consumePendingOrgFeedbackLink('/work/a', '/work/a')).toEqual({ requestId: 'r-1', orgId: 'org-1', workspacePath: '/work/a' });
  });

  it('opens the organization window from another org workspace', async () => {
    const router = setup({ findWorkspaceForOrgId: async () => '/work/b' });

    expect(await router.openFeedbackRequest({ requestId: 'r-1', orgId: 'org-1' })).toBe(true);
    expect(openedOrgWindows).toEqual([{ orgId: 'org-1', workspacePath: '/work/b', feedbackRequestId: 'r-1' }]);
  });

  it('falls back to the organization window when the focused window closes during the lookup', async () => {
    let destroyed = false;
    const win = { ...fakeWindow(), isDestroyed: () => destroyed };
    const router = setup({
      focusedWorkspace: () => ({ window: win, workspacePath: '/work/a' }),
      findTeamForWorkspace: async () => {
        destroyed = true;
        return { orgId: 'org-1' };
      },
      findWorkspaceForOrgId: async () => '/work/a',
    });

    expect(await router.openFeedbackRequest({ requestId: 'r-1', orgId: 'org-1' })).toBe(true);
    expect(win.sent).toEqual([]);
    expect(consumePendingOrgFeedbackLink('/work/a', '/work/a')).toBeNull();
    expect(openedOrgWindows).toEqual([{ orgId: 'org-1', workspacePath: '/work/a', feedbackRequestId: 'r-1' }]);
  });
});

