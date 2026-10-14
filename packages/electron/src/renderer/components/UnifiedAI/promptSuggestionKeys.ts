export interface PromptSuggestionKeyState {
  promptSuggestion: string | null | undefined;
  /** The current draft; a suggestion only fills an empty one. */
  value: string;
  isLoading: boolean | undefined;
}

/**
 * Plain Tab accepts the predicted next prompt into an empty draft while no turn is
 * running. Any modifier leaves the key to its other meaning (Shift+Tab toggles plan mode).
 */
export function shouldAcceptPromptSuggestion(
  e: { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean },
  state: PromptSuggestionKeyState,
): boolean {
  return e.key === 'Tab'
    && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey
    && !!state.promptSuggestion
    && !state.value
    && !state.isLoading;
}
