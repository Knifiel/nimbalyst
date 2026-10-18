import { store } from '../../utils/store';
import { resolveProjectPath } from '../../utils/workspaceDetection';

/**
 * Durable intent to upload transcripts this desktop withheld while their
 * project was not enabled for sync (NIM-7545).
 *
 * - `projects`: enabled since the last reconcile read the server. Their
 *   sessions keep publishing `transcriptSyncDisabled`, because the flag on the
 *   server row is how that reconcile finds which sessions lack a transcript.
 * - `sessions`: found by a reconcile and owed their whole transcript. Each
 *   stays here, keeps its flag, and is re-requested from timestamp 0 on every
 *   reconcile until the provider reports the upload delivered.
 *
 * Persisted so a restart, a failed upload, or a publish that clears the flag
 * cannot lose the history. Memory only moves after the write succeeds.
 */
export interface TranscriptBackfillState {
  projects: string[];
  sessions: string[];
}

export interface TranscriptBackfillStorage {
  read(): unknown;
  write(state: TranscriptBackfillState): void;
}

const appStoreStorage: TranscriptBackfillStorage = {
  read: () => store.get('transcriptBackfill'),
  write: state => store.set('transcriptBackfill', state),
};

function normalize(raw: unknown): TranscriptBackfillState {
  const value = raw as Partial<Record<keyof TranscriptBackfillState, unknown>> | undefined;
  const strings = (list: unknown) => Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [];
  return { projects: strings(value?.projects), sessions: strings(value?.sessions) };
}

export type TranscriptBackfill = ReturnType<typeof createTranscriptBackfill>;

export function createTranscriptBackfill(
  storage: TranscriptBackfillStorage = appStoreStorage,
  resolve: (workspaceId: string) => string = resolveProjectPath,
) {
  let state: TranscriptBackfillState | undefined;
  const current = () => (state ??= normalize(storage.read()));
  const commit = (next: TranscriptBackfillState) => { storage.write(next); state = next; };

  return {
    /** Before the enabled list is saved, so no publish sees the project enabled without its hold. */
    holdProjects(paths: readonly string[]): void {
      const held = current();
      const projects = [...new Set([...held.projects, ...paths])];
      if (projects.length !== held.projects.length) commit({ ...held, projects });
    },
    heldProjects(): ReadonlySet<string> {
      return new Set(current().projects);
    },
    pendingSessions(): ReadonlySet<string> {
      return new Set(current().sessions);
    },
    /** Whether the session must keep its flag: its project is held, or its transcript is still owed. */
    isWithheld(projectId: string, sessionId: string): boolean {
      const { projects, sessions } = current();
      if (sessions.includes(sessionId)) return true;
      return projects.length > 0 && (projects.includes(projectId) || projects.includes(resolve(projectId)));
    },
    /**
     * One write per reconcile: add the sessions it found owing history,
     * release the holds it covered, and drop entries for sessions that no
     * longer exist anywhere.
     */
    recordReconcile(found: readonly string[], releasedProjects: ReadonlySet<string>, exists: (sessionId: string) => boolean): void {
      const held = current();
      const sessions = [...new Set([...held.sessions.filter(exists), ...found])];
      const projects = held.projects.filter(path => !releasedProjects.has(path));
      if (sessions.length === held.sessions.length && sessions.every((id, i) => id === held.sessions[i]) && projects.length === held.projects.length) return;
      commit({ projects, sessions });
    },
    /** The provider reported the upload delivered, or that it can never be delivered. */
    settle(sessionId: string): boolean {
      const held = current();
      if (!held.sessions.includes(sessionId)) return false;
      commit({ ...held, sessions: held.sessions.filter(id => id !== sessionId) });
      return true;
    },
  };
}

export const transcriptBackfill = createTranscriptBackfill();
