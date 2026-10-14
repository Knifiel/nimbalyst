// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shouldAcceptPromptSuggestion } from '../promptSuggestionKeys';
import { store } from '../../../store';
import { sessionPromptSuggestionAtom } from '../../../store/atoms/promptSuggestion';
import { sessionProcessingAtom } from '../../../store/atoms/sessions';
import { initPromptSuggestionListeners } from '../../../store/listeners/promptSuggestionListeners';

const tab = { key: 'Tab', shiftKey: false, metaKey: false, ctrlKey: false, altKey: false };
const ready = { promptSuggestion: 'run the tests', value: '', isLoading: false };

describe('shouldAcceptPromptSuggestion', () => {
  it('accepts plain Tab on an empty draft while idle', () => {
    expect(shouldAcceptPromptSuggestion(tab, ready)).toBe(true);
  });

  it('leaves Tab alone when the draft has text, a turn is running, or nothing is suggested', () => {
    expect(shouldAcceptPromptSuggestion(tab, { ...ready, value: 'x' })).toBe(false);
    expect(shouldAcceptPromptSuggestion(tab, { ...ready, isLoading: true })).toBe(false);
    expect(shouldAcceptPromptSuggestion(tab, { ...ready, promptSuggestion: null })).toBe(false);
  });

  it('leaves modified Tab to its other meaning, such as Shift+Tab for plan mode', () => {
    expect(shouldAcceptPromptSuggestion({ ...tab, shiftKey: true }, ready)).toBe(false);
    expect(shouldAcceptPromptSuggestion({ ...tab, metaKey: true }, ready)).toBe(false);
    expect(shouldAcceptPromptSuggestion({ ...tab, key: 'Enter' }, ready)).toBe(false);
  });
});

describe('initPromptSuggestionListeners', () => {
  afterEach(() => {
    store.set(sessionPromptSuggestionAtom('s1'), null);
    store.set(sessionProcessingAtom('s2'), false);
    vi.unstubAllGlobals();
  });

  it('stores the suggestion per session and ignores payloads with no text', () => {
    let handler: (data: unknown) => void = () => {};
    const unsubscribe = vi.fn();
    vi.stubGlobal('window', {
      electronAPI: { on: (channel: string, cb: (data: unknown) => void) => {
        expect(channel).toBe('ai:promptSuggestion');
        handler = cb;
        return unsubscribe;
      } },
    });

    const cleanup = initPromptSuggestionListeners();
    handler({ sessionId: 's1', suggestion: '' });
    expect(store.get(sessionPromptSuggestionAtom('s1'))).toBeNull();
    handler({ sessionId: 's1', suggestion: 'run the tests' });
    expect(store.get(sessionPromptSuggestionAtom('s1'))).toBe('run the tests');
    expect(store.get(sessionPromptSuggestionAtom('s2'))).toBeNull();

    // A late frame for a session whose next turn is already running is the previous turn's.
    store.set(sessionProcessingAtom('s2'), true);
    handler({ sessionId: 's2', suggestion: 'stale' });
    expect(store.get(sessionPromptSuggestionAtom('s2'))).toBeNull();

    cleanup();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
