import { collaboratorDisplayName } from '@nimbalyst/runtime/sync/collaboratorDisplayName';
import type { CollabDocumentConfig } from './collabDocumentOpener';

/** The name this user's cursor and presence carry in a shared document; never the member id. */
export function collabPresenceName(config: Pick<CollabDocumentConfig, 'userName' | 'userEmail' | 'teamMemberId'>): string {
  return collaboratorDisplayName({ name: config.userName, email: config.userEmail, memberId: config.teamMemberId });
}
