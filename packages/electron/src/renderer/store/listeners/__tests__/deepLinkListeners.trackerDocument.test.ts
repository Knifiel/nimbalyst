// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import { openSettingsCommandAtom } from '../../atoms/settingsNavigation';
import { errorNotificationService } from '../../../services/ErrorNotificationService';
import { activeWorkspacePathAtom } from '../../atoms/openProjects';
import { pendingCollabDocumentAtom } from '../../atoms/collabDocuments';
import {
  trackerModeDocumentItemIdAtom,
  trackerModeLayoutAtom,
} from '../../atoms/trackers';
import { resetWindowMode, windowModeAtom } from '../../atoms/windowMode';
import { activeExtensionPanelAtom, extensionPanelStateAtomFamily } from '../../atoms/extensionPanels';
import { initDeepLinkListeners } from '../deepLinkListeners';
import {
  resetCommentPanelRequests,
  subscribeCommentPanelRequests,
} from '../../../components/TabEditor/collabCommentPanelRequests';
import { normalizeSettingsDestination } from '../../../components/Settings/settingsRoutes';
import {
  consumeInboxRowSelectionRequest,
} from '../../../components/TeamMode/orgWindowCommandBus';
import {
  conversationRoute,
  PROJECT_ORG_MODE_SURFACE_ID,
  orgWindowRouteAtomFamily,
} from '../../../components/TeamMode/orgWindowState';

/** What App.tsx actually navigates to for the currently-queued settings command. */
function resolvedSettingsDestination() {
  const command = store.get(openSettingsCommandAtom);
  if (!command) return null;
  return normalizeSettingsDestination({ category: command.category, scope: command.scope });
}

describe('tracker deep-link routing', () => {
  let cleanup: (() => void) | undefined;
  let handlers: Record<string, (data: any) => void>;
  let pendingTrackerPayload: Record<string, unknown> | null;
  let pendingDocPayload: Record<string, unknown> | null;

  /** Main queues the link and signals the window; the renderer consumes it. */
  async function deliverSharedDocument(payload: Record<string, unknown>) {
    pendingDocPayload = payload;
    handlers['deep-link:shared-document-available']({ workspacePath: payload.workspacePath });
    await vi.waitFor(() => expect(pendingDocPayload).toBeNull());
    await Promise.resolve();
  }

  beforeEach(() => {
    handlers = {};
    pendingTrackerPayload = null;
    pendingDocPayload = null;
    store.set(activeWorkspacePathAtom, '/workspace/source');
    store.set(windowModeAtom, 'files');
    store.set(extensionPanelStateAtomFamily('/workspace/target'), {
      panelId: 'com.nimbalyst.project-graph.graph', bottomPanelId: null, revision: 1, hydrated: true,
    });
    store.set(pendingCollabDocumentAtom, null);
    store.set(
      orgWindowRouteAtomFamily(PROJECT_ORG_MODE_SURFACE_ID),
      conversationRoute('conversation-before-link'),
    );
    consumeInboxRowSelectionRequest(PROJECT_ORG_MODE_SURFACE_ID);
    store.set(trackerModeLayoutAtom, {
      ...store.get(trackerModeLayoutAtom),
      selectedType: 'plan',
      selectedItemId: null,
      itemViews: {},
    });

    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        invoke: vi.fn(async (channel: string) => {
          if (channel === 'deep-link:consume-pending-tracker') {
            return pendingTrackerPayload;
          }
          if (channel === 'deep-link:consume-pending-shared-doc') {
            const pending = pendingDocPayload;
            pendingDocPayload = null;
            return pending;
          }
          return null;
        }),
        on: vi.fn((event: string, handler: (data: any) => void) => {
          handlers[event] = handler;
          return () => delete handlers[event];
        }),
        featureUsage: {
          record: vi.fn(async () => undefined),
        },
      },
    });
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    resetWindowMode();
    store.set(activeWorkspacePathAtom, null);
    store.set(windowModeAtom, 'files');
    store.set(pendingCollabDocumentAtom, null);
    consumeInboxRowSelectionRequest(PROJECT_ORG_MODE_SURFACE_ID);
    resetCommentPanelRequests();
  });

  it('binds a shared-document link to the workspace scope selected by the desktop host', async () => {
    cleanup = initDeepLinkListeners();

    await deliverSharedDocument({
      documentId: 'doc-target',
      orgId: 'org-target',
      workspacePath: '/workspace/target',
    });

    expect(store.get(activeWorkspacePathAtom)).toBe('/workspace/target');
    expect(store.get(windowModeAtom)).toBe('collab');
    expect(store.get(activeExtensionPanelAtom)).toBeNull();
    expect(store.get(pendingCollabDocumentAtom)).toMatchObject({
      documentId: 'doc-target',
      scopeKey: '/workspace/target',
      orgId: 'org-target',
      analyticsSource: 'deep_link',
    });
  });

  it('carries a comment notification thread target to the document comments pane', async () => {
    cleanup = initDeepLinkListeners();

    await deliverSharedDocument({
      documentId: 'doc-target',
      orgId: 'org-target',
      workspacePath: '/workspace/target',
      threadId: 'thread-7',
    });

    // The pane does not exist yet -- the document is still opening -- so the
    // request has to be waiting for it under the document's own URI. Thread
    // identity only: nothing about where the anchor is travels with the link.
    const delivered: unknown[] = [];
    const unsubscribe = subscribeCommentPanelRequests(
      'collab://org:org-target:doc:doc-target',
      (request) => delivered.push(request),
    );
    unsubscribe();

    expect(delivered).toEqual([{ threadId: 'thread-7', source: 'deep-link' }]);
  });

  it('keeps links without view on the plain tracker selection path', () => {
    cleanup = initDeepLinkListeners();

    handlers['deep-link:open-tracker']({
      trackerId: 'tracker-plain',
      orgId: 'org-1',
      workspacePath: '/workspace/target',
    });

    expect(store.get(activeWorkspacePathAtom)).toBe('/workspace/target');
    expect(store.get(windowModeAtom)).toBe('tracker');
    expect(store.get(activeExtensionPanelAtom)).toBeNull();
    expect(store.get(trackerModeLayoutAtom)).toMatchObject({
      selectedType: 'all',
      selectedItemId: 'tracker-plain',
      itemViews: {},
    });
    expect(store.get(trackerModeDocumentItemIdAtom)).toBeNull();
  });

  it('drains a pending view=document link into document presentation', async () => {
    pendingTrackerPayload = {
      trackerId: 'tracker-document',
      orgId: 'org-1',
      workspacePath: '/workspace/source',
      view: 'document',
    };

    cleanup = initDeepLinkListeners();

    await vi.waitFor(() => {
      expect(store.get(trackerModeDocumentItemIdAtom)).toBe('tracker-document');
    });
    expect(store.get(windowModeAtom)).toBe('tracker');
    expect(store.get(trackerModeLayoutAtom)).toMatchObject({
      selectedType: 'all',
      selectedItemId: 'tracker-document',
      itemViews: { 'tracker-document': 'document' },
    });
  });

  it('opens a project-org feedback request in Org mode with its Inbox row latched', () => {
    cleanup = initDeepLinkListeners();

    handlers['deep-link:open-org-feedback-request']({
      requestId: 'request-target',
      orgId: 'org-project',
      workspacePath: '/workspace/target',
    });

    expect(store.get(activeWorkspacePathAtom)).toBe('/workspace/target');
    expect(store.get(windowModeAtom)).toBe('org');
    expect(store.get(activeExtensionPanelAtom)).toBeNull();
    // "Awaiting my reply" is the row a feedback request belongs to, and the
    // reason axis is navigation now — landing on All would show the recipient
    // every delivery except, potentially, the one they clicked a link for.
    expect(store.get(orgWindowRouteAtomFamily(PROJECT_ORG_MODE_SURFACE_ID)))
      .toEqual({ view: 'inbox', filter: 'awaiting' });
    expect(consumeInboxRowSelectionRequest(PROJECT_ORG_MODE_SURFACE_ID)).toEqual({
      orgId: 'org-project',
      sourceKind: 'feedbackRequest',
      sourceId: 'request-target',
    });
  });
});

describe('team-invitation deep-link handoff', () => {
  let cleanup: (() => void) | undefined;
  let handlers: Record<string, (data: any) => void>;
  /** Stands in for main's consume-and-clear: reading it hands over ownership. */
  let pendingInvite: Record<string, unknown> | null;
  let consumeCount: number;

  beforeEach(() => {
    handlers = {};
    pendingInvite = null;
    consumeCount = 0;
    store.set(openSettingsCommandAtom, null);
    vi.spyOn(errorNotificationService, 'showInfo').mockReturnValue('');
    vi.spyOn(errorNotificationService, 'showWarning').mockReturnValue('');

    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        invoke: vi.fn(async (channel: string) => {
          if (channel === 'deep-link:consume-pending-team-invite') {
            consumeCount += 1;
            const pending = pendingInvite;
            pendingInvite = null;
            return pending;
          }
          return null;
        }),
        on: vi.fn((event: string, handler: (data: any) => void) => {
          handlers[event] = handler;
          return () => delete handlers[event];
        }),
        featureUsage: { record: vi.fn(async () => undefined) },
      },
    });
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    vi.restoreAllMocks();
    store.set(openSettingsCommandAtom, null);
  });

  it('applies an invitation once even when the nudge races the mount-time drain', async () => {
    pendingInvite = { status: 'accepted', orgId: 'org-acme', teamName: 'Acme' };

    cleanup = initDeepLinkListeners();
    // Main fires the nudge at a window that is already draining. The outcome
    // must be read through the consuming IPC, never carried on the event, or
    // the invitee sees the same toast twice.
    handlers['deep-link:team-invite-available']?.(undefined);

    await vi.waitFor(() => expect(consumeCount).toBeGreaterThanOrEqual(2));
    expect(errorNotificationService.showInfo).toHaveBeenCalledTimes(1);
    expect(errorNotificationService.showInfo).toHaveBeenCalledWith(
      'You joined Acme',
      expect.any(String),
      expect.anything(),
    );
  });

  it('sends an invitee with no matching account to the account sign-in panel', async () => {
    pendingInvite = {
      status: 'sign-in-required',
      orgId: 'org-acme',
      email: 'invitee@test.com',
    };

    cleanup = initDeepLinkListeners();

    // Asserted through the resolver App.tsx feeds the command into, not on the
    // raw command: a scope-less `{ category: 'account' }` normalizes all the way
    // down to Application -> Notifications, which is where invitees were landing
    // with nothing on screen to sign in with.
    await vi.waitFor(() => {
      expect(resolvedSettingsDestination()).toEqual({ scope: 'account', category: 'account' });
    });
    expect(errorNotificationService.showWarning).toHaveBeenCalledWith(
      'Sign in to accept this invitation',
      expect.stringContaining('invitee@test.com'),
      expect.anything(),
    );

    // The toast outlives the navigation behind it, so its button has to be able
    // to re-issue the same destination.
    const options = vi.mocked(errorNotificationService.showWarning).mock.calls.at(-1)?.[2];
    expect(options?.action?.label).toBe('Sign in');
    store.set(openSettingsCommandAtom, null);
    options?.action?.onClick();
    expect(resolvedSettingsDestination()).toEqual({ scope: 'account', category: 'account' });
  });
});

/**
 * A link main cannot route used to be a live event to a loaded project window,
 * so a cold start or a Project-Manager-only app dropped it. Main now queues the
 * notice and nudges; whichever window drains it shows it.
 */
describe('deep-link notices', () => {
  let cleanup: (() => void) | undefined;
  let handlers: Record<string, (data: any) => void>;
  let pendingNotices: unknown[];

  beforeEach(() => {
    handlers = {};
    pendingNotices = [];
    vi.spyOn(errorNotificationService, 'showWarning').mockReturnValue('');
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        invoke: vi.fn(async (channel: string) => {
          if (channel === 'deep-link:consume-notices') {
            const drained = pendingNotices;
            pendingNotices = [];
            return drained;
          }
          return null;
        }),
        on: vi.fn((event: string, handler: (data: any) => void) => {
          handlers[event] = handler;
          return () => delete handlers[event];
        }),
        openInBrowser: vi.fn(async () => undefined),
        featureUsage: { record: vi.fn(async () => undefined) },
      },
    });
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    vi.restoreAllMocks();
  });

  it('shows a notice queued before the window mounted', async () => {
    pendingNotices = [{ kind: 'shared-document', reason: 'no-workspace', orgId: 'org-1', documentId: 'doc-1' }];

    cleanup = initDeepLinkListeners();

    await vi.waitFor(() => expect(errorNotificationService.showWarning).toHaveBeenCalledTimes(1));
    expect(errorNotificationService.showWarning).toHaveBeenCalledWith(
      'No matching project',
      expect.stringContaining('document'),
      expect.anything(),
    );
  });

  it('drains on a nudge and offers the console for a feedback request it cannot open', async () => {
    cleanup = initDeepLinkListeners();
    await Promise.resolve();

    pendingNotices = [{ kind: 'feedback-request', reason: 'no-workspace', orgId: 'org-1', requestId: 'req-1' }];
    handlers['deep-link:notice-available']?.(undefined);

    await vi.waitFor(() => expect(errorNotificationService.showWarning).toHaveBeenCalledTimes(1));
    const options = vi.mocked(errorNotificationService.showWarning).mock.calls[0]?.[2];
    expect(options?.action?.label).toBe('Open in browser');
    options?.action?.onClick();
    expect(window.electronAPI.openInBrowser).toHaveBeenCalledWith(
      expect.stringMatching(/\/org\/org-1\/feedback\/req-1$/),
    );
  });

  it('asks a signed-out user to sign in', async () => {
    pendingNotices = [{ kind: 'feedback-request', reason: 'not-authenticated', orgId: 'org-1', requestId: 'req-1' }];

    cleanup = initDeepLinkListeners();

    await vi.waitFor(() => expect(errorNotificationService.showWarning).toHaveBeenCalledWith(
      'Sign in required',
      expect.stringContaining('feedback request'),
      expect.anything(),
    ));
  });
});

/**
 * A live link used to be queued in main AND carried on the event, and only the
 * queue was ever drained: switching projects away and back reopened a link the
 * user had already left, and a slow drain could land over a newer link. The
 * link is now read only through main's consuming queue.
 */
describe('shared-document links are applied once', () => {
  let cleanup: (() => void) | undefined;
  let handlers: Record<string, (data: any) => void>;
  /** Stands in for main's destructive per-workspace queue. */
  let queue: Map<string, Record<string, unknown>>;
  let heldDocConsume: Array<() => void>;
  let holdDocConsumes: boolean;

  beforeEach(() => {
    handlers = {};
    queue = new Map();
    heldDocConsume = [];
    holdDocConsumes = false;
    store.set(activeWorkspacePathAtom, '/workspace/target');
    store.set(pendingCollabDocumentAtom, null);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        invoke: vi.fn(async (channel: string, workspacePath?: string) => {
          if (channel !== 'deep-link:consume-pending-shared-doc') return null;
          const take = () => {
            const pending = workspacePath ? queue.get(workspacePath) ?? null : null;
            if (workspacePath) queue.delete(workspacePath);
            return pending ? { ...pending, workspacePath } : null;
          };
          if (!holdDocConsumes) return take();
          // Main answers in order; the renderer may still apply out of order.
          const value = take();
          return new Promise((resolve) => heldDocConsume.push(() => resolve(value)));
        }),
        on: vi.fn((event: string, handler: (data: any) => void) => {
          handlers[event] = handler;
          return () => delete handlers[event];
        }),
        featureUsage: { record: vi.fn(async () => undefined) },
      },
    });
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    store.set(activeWorkspacePathAtom, null);
    store.set(pendingCollabDocumentAtom, null);
  });

  it('does not reopen a link after the user switched projects away and back', async () => {
    cleanup = initDeepLinkListeners();
    await Promise.resolve();

    queue.set('/workspace/target', { documentId: 'doc-1', orgId: 'org-1' });
    handlers['deep-link:shared-document-available']({ workspacePath: '/workspace/target' });
    await vi.waitFor(() => expect(store.get(pendingCollabDocumentAtom)?.documentId).toBe('doc-1'));

    // The user moves on, then switches away and back.
    store.set(pendingCollabDocumentAtom, null);
    store.set(activeWorkspacePathAtom, '/workspace/other');
    store.set(activeWorkspacePathAtom, '/workspace/target');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.get(pendingCollabDocumentAtom)).toBeNull();
  });

  it('does not let an older drain land over a newer link', async () => {
    holdDocConsumes = true;
    queue.set('/workspace/target', { documentId: 'doc-old', orgId: 'org-1' });
    cleanup = initDeepLinkListeners();
    await vi.waitFor(() => expect(heldDocConsume).toHaveLength(1));

    queue.set('/workspace/target', { documentId: 'doc-new', orgId: 'org-1' });
    handlers['deep-link:shared-document-available']({ workspacePath: '/workspace/target' });
    await vi.waitFor(() => expect(heldDocConsume).toHaveLength(2));

    // The newer answer is applied first; the older drain resolves after it.
    heldDocConsume[1]();
    await vi.waitFor(() => expect(store.get(pendingCollabDocumentAtom)?.documentId).toBe('doc-new'));
    heldDocConsume[0]();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.get(pendingCollabDocumentAtom)?.documentId).toBe('doc-new');
  });
});
