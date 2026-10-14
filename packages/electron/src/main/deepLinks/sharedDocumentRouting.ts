/**
 * Routing for shared-document and shared-folder deep links:
 *
 *   nimbalyst://doc/<documentId>?orgId=<orgId>[&projectId=<teamProjectId>][&threadId=...]
 *   nimbalyst://folder/<folderId>?orgId=<orgId>[&projectId=<teamProjectId>]
 *
 * Pages are per project, so a link to project B's page opened in a workspace
 * on project A shows a sidebar without it. When the link names its project the
 * router prefers a workspace whose team project is that one, open or recent,
 * and only then any workspace of the org (the renderer can still open another
 * project's page from the team index). A link without a project routes by org,
 * and the renderer resolves the page's project from the team doc index.
 *
 * No Electron imports: `registerDeepLinkRouting.ts` supplies the windows.
 */
import { parseDocumentDeepLinkAnchor, type SharedDocumentAnchor } from '../../shared/documentDeepLinks';
import type { DeepLinkNotice } from '../../shared/deepLinkNotices';
import { currentTeamProjectId } from '../services/teamCurrentProject';
import type { TeamDetails } from '../services/TeamService';

export interface SharedDocumentLink {
  documentId: string;
  orgId: string;
  projectId: string | null;
  anchor: SharedDocumentAnchor;
}

export interface SharedFolderLink {
  folderId: string;
  orgId: string;
  projectId: string | null;
}

export interface DeepLinkWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  focus(): void;
  webContents: { send(channel: string, payload: unknown): void };
}

type WorkspaceTeam = Pick<TeamDetails, 'orgId' | 'teamProjectId'> & Partial<Pick<TeamDetails, 'projects'>>;

export interface SharedDocumentRoutingDeps {
  isAuthenticated(): boolean;
  /** Workspaces of open windows, active and rail-warm, in window order. */
  openWorkspacePaths(): string[];
  recentWorkspacePaths(): string[];
  findTeamForWorkspace(workspacePath: string): Promise<WorkspaceTeam | null>;
  findWindowByWorkspace(workspacePath: string): DeepLinkWindow | null;
  createWindowForWorkspace(workspacePath: string): void;
  notify(notice: DeepLinkNotice): void;
  log: { info(message: string, data?: unknown): void; warn(message: string, data?: unknown): void };
}

type PendingDocument = Omit<SharedDocumentLink, 'anchor'> & SharedDocumentAnchor;
type PendingFolder = SharedFolderLink;

function pathSegmentId(parsed: URL, host: string): string | null | undefined {
  const encoded = parsed.host === host
    ? parsed.pathname.replace(/^\//, '')
    : parsed.pathname.startsWith(`/${host}/`) ? parsed.pathname.slice(host.length + 2) : undefined;
  if (encoded === undefined) return undefined;
  if (!encoded) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

function parseLink(rawUrl: string, host: 'doc' | 'folder'): { id: string; orgId: string; projectId: string | null; url: URL } | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'nimbalyst:') return null;
  const id = pathSegmentId(parsed, host);
  const orgId = parsed.searchParams.get('orgId');
  if (!id || !orgId) return null;
  return { id, orgId, projectId: parsed.searchParams.get('projectId') || null, url: parsed };
}

/** Null for anything that is not a complete `nimbalyst://doc/...` link. */
export function parseSharedDocumentDeepLink(rawUrl: string): SharedDocumentLink | null {
  const link = parseLink(rawUrl, 'doc');
  return link
    ? { documentId: link.id, orgId: link.orgId, projectId: link.projectId, anchor: parseDocumentDeepLinkAnchor(link.url) }
    : null;
}

/** Null for anything that is not a complete `nimbalyst://folder/...` link. */
export function parseSharedFolderDeepLink(rawUrl: string): SharedFolderLink | null {
  const link = parseLink(rawUrl, 'folder');
  return link ? { folderId: link.id, orgId: link.orgId, projectId: link.projectId } : null;
}

export function createSharedDocumentRouter(deps: SharedDocumentRoutingDeps) {
  const pendingDocuments = new Map<string, PendingDocument>();
  const pendingFolders = new Map<string, PendingFolder>();

  /**
   * The workspace a link for `orgId` (and `projectId`, when the link has one)
   * opens in: open windows first, then recent workspaces. With a project, a
   * workspace on that project wins over an earlier one that is only in the org.
   */
  async function findWorkspaceForTeamProject(orgId: string, projectId: string | null): Promise<string | null> {
    const seen = new Set<string>();
    let orgMatch: string | null = null;
    for (const workspacePath of [...deps.openWorkspacePaths(), ...deps.recentWorkspacePaths()]) {
      if (seen.has(workspacePath)) continue;
      seen.add(workspacePath);
      const team = await deps.findTeamForWorkspace(workspacePath);
      if (team?.orgId !== orgId) continue;
      if (!projectId) return workspacePath;
      if (currentTeamProjectId(team) === projectId) return workspacePath;
      orgMatch ??= workspacePath;
    }
    return orgMatch;
  }

  /**
   * Focuses `workspacePath`'s window and signals it, or opens a window that
   * drains the queue on mount. The signal carries no link: the renderer reads
   * it through the consuming queue, so it is applied exactly once.
   */
  function deliver(workspacePath: string, channel: string, what: string): void {
    const existing = deps.findWindowByWorkspace(workspacePath);
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.focus();
      existing.webContents.send(channel, { workspacePath });
      deps.log.info(`[DeepLink] Routed ${what} to existing window:`, { workspacePath });
      return;
    }
    deps.log.info(`[DeepLink] Opening new window for ${what} workspace:`, { workspacePath });
    deps.createWindowForWorkspace(workspacePath);
  }

  return {
    findWorkspaceForTeamProject,

    /**
     * `anchor.threadId` is present when the link came from a comment
     * notification; it is carried verbatim to the renderer, which opens the
     * comments panel on that thread.
     */
    async openSharedDocument(link: SharedDocumentLink): Promise<boolean> {
      const { documentId, orgId, projectId, anchor } = link;
      const authenticated = deps.isAuthenticated();
      const workspacePath = authenticated ? await findWorkspaceForTeamProject(orgId, projectId) : null;
      if (!workspacePath) {
        const reason = authenticated ? 'no-workspace' : 'not-authenticated';
        deps.log.warn('[DeepLink] Cannot route shared doc:', { reason, orgId, projectId, documentId });
        deps.notify({ kind: 'shared-document', reason, orgId, documentId });
        return false;
      }
      pendingDocuments.set(workspacePath, { documentId, orgId, projectId, ...anchor });
      deliver(workspacePath, 'deep-link:shared-document-available', 'shared doc');
      return true;
    },

    /** Same flow as documents; the renderer focuses the folder in Pages. */
    async openSharedFolder(link: SharedFolderLink): Promise<boolean> {
      const { folderId, orgId, projectId } = link;
      const authenticated = deps.isAuthenticated();
      const workspacePath = authenticated ? await findWorkspaceForTeamProject(orgId, projectId) : null;
      if (!workspacePath) {
        const reason = authenticated ? 'no-workspace' : 'not-authenticated';
        deps.log.warn('[DeepLink] Cannot route shared folder:', { reason, orgId, projectId, folderId });
        deps.notify({ kind: 'shared-folder', reason, orgId, folderId });
        return false;
      }
      pendingFolders.set(workspacePath, { folderId, orgId, projectId });
      deliver(workspacePath, 'deep-link:shared-folder-available', 'shared folder');
      return true;
    },

    consumePendingSharedDocument(workspacePath: string): (PendingDocument & { workspacePath: string }) | null {
      const pending = workspacePath ? pendingDocuments.get(workspacePath) : undefined;
      if (!pending) return null;
      pendingDocuments.delete(workspacePath);
      return { ...pending, workspacePath };
    },

    consumePendingSharedFolder(workspacePath: string): (PendingFolder & { workspacePath: string }) | null {
      const pending = workspacePath ? pendingFolders.get(workspacePath) : undefined;
      if (!pending) return null;
      pendingFolders.delete(workspacePath);
      return { ...pending, workspacePath };
    },
  };
}

export type SharedDocumentRouter = ReturnType<typeof createSharedDocumentRouter>;
