/**
 * Central IPC listener for next-prompt suggestions.
 *
 * Components never subscribe to IPC directly: this listener writes the
 * per-session atom and the input reads it.
 */

import { store } from '../index';
import { sessionPromptSuggestionAtom } from '../atoms/promptSuggestion';
import { sessionProcessingAtom } from '../atoms/sessions';

export interface PromptSuggestionPayload {
  sessionId: string;
  suggestion: string;
}

export function initPromptSuggestionListeners(): () => void {
  const unsubscribe = window.electronAPI.on('ai:promptSuggestion', (data: PromptSuggestionPayload) => {
    if (!data?.sessionId || !data.suggestion) return;
    // A frame that lands after the next turn started answers the previous one; showing it once
    // that turn ends would present it as a prediction for the wrong turn.
    if (store.get(sessionProcessingAtom(data.sessionId))) return;
    store.set(sessionPromptSuggestionAtom(data.sessionId), data.suggestion);
  });
  return () => unsubscribe?.();
}
