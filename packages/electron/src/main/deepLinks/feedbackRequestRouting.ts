/**
 * Routing for feedback-request links (`nimbalyst://feedback-request/<id>?orgId=`
 * and the console's `https://.../org/<org>/feedback/<id>` clicked in the app):
 * the focused project's Org mode when that project is in the request's org,
 * else the standalone organization window's Inbox.
 *
 * The destination is a selected Inbox row, not a tab: the respond card renders
 * inline in the Inbox's context pane. That pane reads the request through a
 * workspace-scoped target, so a workspace bound to the org has to be
 * resolvable. Without one, or signed out, the user is told why (a notice)
 * unless the caller has its own fallback, such as sending a clicked console
 * link to the browser.
 *
 * No Electron imports: `registerDeepLinkRouting.ts` supplies the windows.
 */
import type { DeepLinkNotice } from '../../shared/deepLinkNotices';
import { resolveOrgMessagingDestination } from '../../shared/orgMessagingRouting';
import { queuePendingOrgFeedbackLink } from '../services/PendingOrgFeedbackLinks';
import type { DeepLinkWindow } from './sharedDocumentRouting';

export interface FeedbackRequestTarget {
  requestId: string;
  orgId: string;
}

export interface FeedbackRequestRoutingDeps {
  isAuthenticated(): boolean;
  /** The most recently focused project window and its active workspace. */
  focusedWorkspace(): { window: DeepLinkWindow; workspacePath: string } | null;
  findTeamForWorkspace(workspacePath: string): Promise<{ orgId: string } | null>;
  findWorkspaceForOrgId(orgId: string): Promise<string | null>;
  openOrganizationWindow(target: { orgId: string; workspacePath: string; feedbackRequestId: string }): void;
  notify(notice: DeepLinkNotice): void;
  log: { info(message: string, data?: unknown): void; warn(message: string, data?: unknown): void };
}

export interface OpenFeedbackRequestOptions {
  /** False when the caller falls back on its own; no notice is shown then. */
  reportFailure?: boolean;
}

export function createFeedbackRequestRouter(deps: FeedbackRequestRoutingDeps) {
  return {
    async openFeedbackRequest(
      { requestId, orgId }: FeedbackRequestTarget,
      { reportFailure = true }: OpenFeedbackRequestOptions = {},
    ): Promise<boolean> {
      const fail = (reason: 'not-authenticated' | 'no-workspace'): false => {
        deps.log.warn('[DeepLink] Cannot route feedback request:', { reason, orgId, requestId });
        if (reportFailure) deps.notify({ kind: 'feedback-request', reason, orgId, requestId });
        return false;
      };

      if (!deps.isAuthenticated()) return fail('not-authenticated');

      const focused = deps.focusedWorkspace();
      if (focused && !focused.window.isDestroyed()) {
        const projectOrgId = (await deps.findTeamForWorkspace(focused.workspacePath))?.orgId;
        // The lookup awaited: a window closed meanwhile falls through to the
        // organization window rather than taking the link with it.
        if (
          !focused.window.isDestroyed()
          && resolveOrgMessagingDestination(projectOrgId, orgId) === 'project-mode'
        ) {
          const { window, workspacePath } = focused;
          queuePendingOrgFeedbackLink(workspacePath, { requestId, orgId });
          if (window.isMinimized()) window.restore();
          window.focus();
          window.webContents.send('deep-link:open-org-feedback-request', { requestId, orgId, workspacePath });
          deps.log.info('[DeepLink] Routed feedback request to project Org mode:', { orgId, requestId, workspacePath });
          return true;
        }
      }

      const workspacePath = await deps.findWorkspaceForOrgId(orgId);
      if (!workspacePath) return fail('no-workspace');

      deps.openOrganizationWindow({ orgId, workspacePath, feedbackRequestId: requestId });
      deps.log.info('[DeepLink] Routed feedback request to the organization window:', { orgId, requestId, workspacePath });
      return true;
    },
  };
}
