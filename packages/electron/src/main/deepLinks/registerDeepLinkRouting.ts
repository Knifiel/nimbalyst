/**
 * Electron wiring for shared-document, shared-folder and feedback-request deep
 * links: the routers in this folder, given real windows, plus the IPC channels
 * renderers drain their queued links and notices through.
 */
import { safeHandle } from '../utils/ipcRegistry';
import { logger } from '../utils/logger';
import { getRecentItems } from '../utils/store';
import { isAuthenticated } from '../services/StytchAuthService';
import { findTeamForWorkspace } from '../services/TeamService';
import {
  createWindow,
  findWindowByWorkspace,
  getMostRecentlyFocusedWorkspaceWindow,
} from '../window/WindowManager';
import {
  getWindowIdForWindow,
  resolveActiveWorkspacePath,
  resolveActiveWorkspacePathForWindowId,
  windowStates,
} from '../window/windowState';
import { createWorkspaceManagerWindow, getWorkspaceManagerWindow } from '../window/WorkspaceManagerWindow';
import { createTeamManagementWindow } from '../window/TeamManagementWindow';
import { setConsoleFeedbackRequestOpener } from '../services/consoleLinks/consoleLinkHandlers';
import { DEEP_LINK_CONSUME_NOTICES_CHANNEL } from '../../shared/deepLinkNotices';
import { createDeepLinkNoticeQueue } from './deepLinkNotices';
import { createSharedDocumentRouter } from './sharedDocumentRouting';
import { createFeedbackRequestRouter } from './feedbackRequestRouting';

const log = {
  info: (message: string, data?: unknown) => logger.main.info(message, data),
  warn: (message: string, data?: unknown) => logger.main.warn(message, data),
};

const notices = createDeepLinkNoticeQueue({
  targetWindow: () => getMostRecentlyFocusedWorkspaceWindow() ?? getWorkspaceManagerWindow(),
  openProjectManager: () => createWorkspaceManagerWindow(),
});

/**
 * Open windows first, active and rail-warm paths alike. Rail-warm paths count
 * as open here (#2916 tracks that); a project match in a recent workspace
 * still beats them.
 */
function openWorkspacePaths(): string[] {
  const paths: string[] = [];
  for (const state of windowStates.values()) {
    const active = resolveActiveWorkspacePath(state);
    if (active) paths.push(active);
    if (state?.workspacePath) paths.push(state.workspacePath);
    paths.push(...(state?.additionalWorkspacePaths ?? []));
  }
  return paths;
}

const sharedDocuments = createSharedDocumentRouter({
  isAuthenticated: () => isAuthenticated(),
  openWorkspacePaths,
  recentWorkspacePaths: () => getRecentItems('workspaces').map((item) => item.path),
  findTeamForWorkspace: (workspacePath) => findTeamForWorkspace(workspacePath),
  findWindowByWorkspace: (workspacePath) => findWindowByWorkspace(workspacePath),
  createWindowForWorkspace: (workspacePath) => {
    createWindow(false, true, workspacePath);
  },
  notify: notices.deliver,
  log,
});

/** A workspace whose team is `orgId`'s, open windows first, then recent ones. */
export function findWorkspaceForOrgId(orgId: string): Promise<string | null> {
  return sharedDocuments.findWorkspaceForTeamProject(orgId, null);
}

const feedbackRequests = createFeedbackRequestRouter({
  isAuthenticated: () => isAuthenticated(),
  focusedWorkspace: () => {
    const window = getMostRecentlyFocusedWorkspaceWindow();
    const workspacePath = resolveActiveWorkspacePathForWindowId(getWindowIdForWindow(window));
    return window && workspacePath ? { window, workspacePath } : null;
  },
  findTeamForWorkspace: (workspacePath) => findTeamForWorkspace(workspacePath),
  findWorkspaceForOrgId: (orgId) => findWorkspaceForOrgId(orgId),
  openOrganizationWindow: (target) => {
    createTeamManagementWindow(target);
  },
  notify: notices.deliver,
  log,
});

export const openSharedDocumentFromDeepLink = sharedDocuments.openSharedDocument;
export const openSharedFolderFromDeepLink = sharedDocuments.openSharedFolder;
export const openFeedbackRequestFromDeepLink = feedbackRequests.openFeedbackRequest;

export function registerDeepLinkRoutingHandlers(): void {
  safeHandle('deep-link:consume-pending-shared-doc', (_event, workspacePath: string) =>
    sharedDocuments.consumePendingSharedDocument(workspacePath));
  safeHandle('deep-link:consume-pending-shared-folder', (_event, workspacePath: string) =>
    sharedDocuments.consumePendingSharedFolder(workspacePath));
  safeHandle(DEEP_LINK_CONSUME_NOTICES_CHANNEL, () => notices.consume());
  // A console feedback link clicked in the app opens like the deep link; when
  // it cannot, the browser is the fallback, so no notice.
  setConsoleFeedbackRequestOpener((target) => feedbackRequests.openFeedbackRequest(target, { reportFailure: false }));
}
