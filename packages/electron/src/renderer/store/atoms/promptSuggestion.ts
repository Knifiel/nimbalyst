import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';

/**
 * The predicted next prompt for a session, set when a Claude Code turn ends and
 * cleared when the user types, sends, or a new turn starts. Live-only: a
 * suggestion from an earlier app run is stale, so it is never persisted.
 */
export const sessionPromptSuggestionAtom = atomFamily((_sessionId: string) =>
  atom<string | null>(null)
);
