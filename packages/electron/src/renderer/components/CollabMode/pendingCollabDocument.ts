/**
 * What Pages does with a pending document request (a deep link, an in-app
 * link, or "Share to Team") once the team scope matches it.
 */

import type { PendingCollabDocument, SharedDocument } from '../../store/atoms/collabDocuments';

export type PendingCollabDocumentResolution =
  | { action: 'open'; document: SharedDocument }
  /** The team index has not delivered its first full list yet. */
  | { action: 'wait' }
  /** The loaded index has no such page: deleted, or not shared with this member. */
  | { action: 'not-found' }
  /** The index cannot be reached, so the page cannot be found out. */
  | { action: 'failed'; message: string };

/** Why the team scope this window would open pages in is not there. */
export interface TeamScopeUnavailable {
  message: string;
  /** False for a settled answer (signed out, no team); true when the lookup gave up. */
  retryable: boolean;
}

/**
 * Why a pending request for this workspace can never open, or null while it
 * still can. Each case clears the request with a message instead of leaving it
 * to wait for a team scope or index that is not coming.
 */
export function pendingCollabDocumentFailure(
  pending: PendingCollabDocument,
  context: {
    teamScope: { orgId: string } | null;
    teamUnavailable: TeamScopeUnavailable | null;
    startError: string | null;
  },
): string | null {
  if (!context.teamScope) {
    if (!context.teamUnavailable) return null;
    return context.teamUnavailable.retryable
      ? `Your team's pages could not be reached: ${context.teamUnavailable.message}`
      : context.teamUnavailable.message;
  }
  if (pending.orgId !== context.teamScope.orgId) {
    return 'This page belongs to a different organization than this project.';
  }
  if (context.startError) return `Your team's pages could not be loaded: ${context.startError}`;
  return null;
}

export function resolvePendingCollabDocument(
  pending: PendingCollabDocument,
  context: {
    /** The scope's own and other projects' pages (`getLinkableSharedDocumentsForScopeKey`). */
    linkableDocuments: SharedDocument[];
    /** True once this connection's team index arrived (`sharedIndexLoadedForScopeAtom`). */
    indexLoaded: boolean;
    /** Why the index cannot be reached (`sharedIndexUnavailableForScopeAtom`), or null. */
    indexUnavailable: string | null;
    teamProjectId: string | null;
    now: number;
  },
): PendingCollabDocumentResolution {
  const found = context.linkableDocuments.find((document) => document.documentId === pending.documentId);
  if (found) {
    return {
      action: 'open',
      document: {
        ...found,
        ...(pending.documentType ? { documentType: pending.documentType } : {}),
        ...(pending.metadataVersion === 2 ? {
          metadataVersion: 2 as const,
          fileExtension: pending.fileExtension,
          editorId: pending.editorId,
        } : {}),
      },
    };
  }
  // A link carries only an id. Opening it before the index names its type
  // mounts the wrong editor (a drawing or mockup opened as markdown is blank),
  // so it waits for the index and never guesses.
  if (!pending.documentType) {
    if (context.indexLoaded) return { action: 'not-found' };
    return context.indexUnavailable ? { action: 'failed', message: context.indexUnavailable } : { action: 'wait' };
  }
  // A caller that supplies the type knows the page: "Share to Team" seeding a
  // page it has just registered, or a pick from an index-backed list.
  return {
    action: 'open',
    document: {
      documentId: pending.documentId,
      teamProjectId: context.teamProjectId,
      title: '',
      documentType: pending.documentType,
      metadataVersion: pending.metadataVersion,
      fileExtension: pending.fileExtension,
      editorId: pending.editorId,
      createdBy: '',
      createdAt: context.now,
      updatedAt: context.now,
    },
  };
}
