import { getSessionStateManager } from '@nimbalyst/runtime/ai/server/SessionStateManager';
import { store } from '../../utils/store';
import { resolveProjectPath } from '../../utils/workspaceDetection';
import { transcriptBackfill, type TranscriptBackfill } from './transcriptBackfill';

/**
 * Predicate handed to `getAllSessionsForSync` so reconciliation never loads
 * sessions from projects the user did not enable. An empty enabled list means
 * "sync nothing", which is what the per-session filter this replaced already
 * did.
 *
 * Sessions running in a git worktree may have a workspaceId of
 * ".../<project>_worktrees/<name>" rather than the parent project path the user
 * enabled in Settings > Sync. Claude sessions normally adopt the parent path via
 * adoptWorktreeForSession(), but the Codex provider currently does not, so a
 * Codex worktree session keeps the raw worktree path. Accept either form.
 * `resolveProjectPath` touches the disk, so this runs once per distinct
 * workspace path rather than once per session.
 */
export function createEnabledProjectFilter(): (workspaceId: string) => boolean {
  const enabledProjectIds = new Set(store.get('sessionSync')?.enabledProjects ?? []);
  return (workspaceId: string) =>
    enabledProjectIds.has(workspaceId) || enabledProjectIds.has(resolveProjectPath(workspaceId));
}

/**
 * Whether a project is enabled right now. The enabled list is read on every
 * call so a Settings change applies without restarting sync; each workspace
 * path resolves (a disk touch) once.
 */
export function createLiveProjectEnabledCheck(
  getEnabledProjects: () => readonly string[] = () => store.get('sessionSync')?.enabledProjects ?? [],
  resolve: (workspaceId: string) => string = resolveProjectPath,
): (workspaceId: string) => boolean {
  const resolvedByWorkspace = new Map<string, string>();
  return (workspaceId) => {
    const enabled = getEnabledProjects();
    if (enabled.includes(workspaceId)) return true;
    let resolved = resolvedByWorkspace.get(workspaceId);
    if (resolved === undefined) {
      resolved = resolve(workspaceId);
      resolvedByWorkspace.set(workspaceId, resolved);
    }
    return enabled.includes(resolved);
  };
}

/**
 * The live-message counterpart of the reconcile filter (NIM-7479): whether a
 * session's new transcript rows may be uploaded. The session's workspace is
 * looked up once.
 */
export function createLiveSessionSyncFilter(
  getWorkspaceId: (sessionId: string) => Promise<string | null | undefined>,
  getEnabledProjects?: () => readonly string[],
  resolve?: (workspaceId: string) => string,
): (sessionId: string) => Promise<boolean> {
  const workspaceBySession = new Map<string, string | null>();
  const isEnabled = createLiveProjectEnabledCheck(getEnabledProjects, resolve);
  return async (sessionId) => {
    let workspaceId = workspaceBySession.get(sessionId);
    if (workspaceId === undefined) {
      workspaceId = (await getWorkspaceId(sessionId)) ?? null;
      workspaceBySession.set(sessionId, workspaceId);
    }
    return workspaceId !== null && isEnabled(workspaceId);
  };
}

/**
 * The provider's `isTranscriptSyncDisabled`: true for a project the user has
 * not enabled, a project enabled so recently no reconcile has read the server
 * since, or a session whose earlier transcript is still owed (see
 * transcriptBackfill.ts).
 */
export function createTranscriptSyncDisabledPredicate(
  backfill: Pick<TranscriptBackfill, 'isWithheld'> = transcriptBackfill,
  getEnabledProjects?: () => readonly string[],
  resolve?: (workspaceId: string) => string,
): (projectId: string, sessionId: string) => boolean {
  const isEnabled = createLiveProjectEnabledCheck(getEnabledProjects, resolve);
  return (projectId, sessionId) => !isEnabled(projectId) || backfill.isWithheld(projectId, sessionId);
}

/** A turn in progress on this desktop; its rows publish live (see selectSessionsForIndexSync). */
export function isSessionMidTurn(sessionId: string): boolean {
  const status = getSessionStateManager().getSessionState(sessionId)?.status;
  return status === 'running' || status === 'waiting_for_input';
}
