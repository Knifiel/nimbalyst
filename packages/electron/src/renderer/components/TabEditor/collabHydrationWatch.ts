/**
 * Tells a shared page that cannot connect from one that is slow to load.
 *
 * The hydration overlay covers a shared page until its room first answers.
 * The provider retries a failed connect forever with backoff, so without this
 * a refused (403) or unreachable room showed "Loading from server..." for as
 * long as the tab stayed open. Each attempt that drops before the room
 * answers counts; an auth refusal fails at once, anything else after a few.
 */

import type { DocumentSyncStatus } from '@nimbalyst/runtime/sync';

export interface CollabHydrationFailure {
  /** `open-failed`: the local copy or its provider could not be set up. */
  kind: 'no-access' | 'unreachable' | 'open-failed';
  message: string;
}

const UNREACHABLE_AFTER_FAILED_ATTEMPTS = 2;

export class CollabHydrationWatch {
  private attempting = false;
  private failedAttempts = 0;
  private hydrated = false;

  /**
   * Feed every transport status. Returns the failure to show once the page
   * cannot load, else null; after the first hydration always null.
   */
  observe(status: DocumentSyncStatus, authRejectionStatus: number | null): CollabHydrationFailure | null {
    if (this.hydrated) return null;
    switch (status) {
      case 'connected':
      case 'replaying':
        this.hydrated = true;
        return null;
      case 'connecting':
      case 'syncing':
        this.attempting = true;
        return null;
      case 'error':
        return { kind: 'unreachable', message: 'The server refused this page.' };
      case 'disconnected':
      case 'offline-unsynced': {
        if (!this.attempting) return null;
        this.attempting = false;
        this.failedAttempts += 1;
        if (authRejectionStatus === 401 || authRejectionStatus === 403 || authRejectionStatus === 404) {
          return { kind: 'no-access', message: "You don't have access to this page, or it no longer exists." };
        }
        return this.failedAttempts >= UNREACHABLE_AFTER_FAILED_ATTEMPTS
          ? { kind: 'unreachable', message: 'Could not reach the collaboration server.' }
          : null;
      }
    }
  }

  /** Start counting again, for a user's Retry. */
  reset(): void {
    this.attempting = false;
    this.failedAttempts = 0;
  }
}
