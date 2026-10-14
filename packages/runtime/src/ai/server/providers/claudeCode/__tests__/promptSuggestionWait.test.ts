// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  canAdoptAwaitingSuggestionQuery,
  extractPromptSuggestion,
  shouldAwaitPromptSuggestion,
  type AdoptAwaitingSuggestionFacts,
  type AwaitPromptSuggestionFacts,
} from '../promptSuggestionWait';
import { isTransientClaudeCodeFrame } from '../../../../../storage/nonRenderingFrames';

const awaitFacts = (over: Partial<AwaitPromptSuggestionFacts> = {}): AwaitPromptSuggestionFacts => ({
  enabled: true,
  hasSessionId: true,
  willDrainSubagents: false,
  resultIsError: false,
  planMode: false,
  firstTurn: false,
  wasInterrupted: false,
  ...over,
});

const adoptFacts = (over: Partial<AdoptAwaitingSuggestionFacts> = {}): AdoptAwaitingSuggestionFacts => ({
  awaiting: true,
  hasLeadQuery: true,
  promptStreamOpen: true,
  wasInterrupted: false,
  hasPendingUserInteraction: false,
  hasTeammateWork: false,
  hasPendingContinuation: false,
  handoffInProgress: false,
  ...over,
});

describe('shouldAwaitPromptSuggestion', () => {
  it('waits only when enabled and the CLI would not suppress the suggestion', () => {
    expect(shouldAwaitPromptSuggestion(awaitFacts())).toBe(true);
    for (const off of [
      { enabled: false },
      { hasSessionId: false },
      { willDrainSubagents: true },
      { resultIsError: true },
      { planMode: true },
      { firstTurn: true },
      { wasInterrupted: true },
    ]) {
      expect(shouldAwaitPromptSuggestion(awaitFacts(off))).toBe(false);
    }
  });
});

describe('canAdoptAwaitingSuggestionQuery', () => {
  it('lets a follow-up take over a turn that is only waiting for the suggestion', () => {
    expect(canAdoptAwaitingSuggestionQuery(adoptFacts())).toBe(true);
  });

  it('refuses when not waiting, or when anything else is using the query', () => {
    for (const off of [
      { awaiting: false },
      { hasLeadQuery: false },
      { promptStreamOpen: false },
      { wasInterrupted: true },
      { hasPendingUserInteraction: true },
      { hasTeammateWork: true },
      { hasPendingContinuation: true },
      { handoffInProgress: true },
    ]) {
      expect(canAdoptAwaitingSuggestionQuery(adoptFacts(off))).toBe(false);
    }
  });
});

describe('extractPromptSuggestion', () => {
  it('returns trimmed text for a prompt_suggestion frame and null otherwise', () => {
    expect(extractPromptSuggestion({ type: 'prompt_suggestion', suggestion: '  run the tests  ' })).toBe('run the tests');
    expect(extractPromptSuggestion({ type: 'prompt_suggestion', suggestion: '   ' })).toBeNull();
    expect(extractPromptSuggestion({ type: 'assistant', suggestion: 'x' })).toBeNull();
    expect(extractPromptSuggestion('prompt_suggestion')).toBeNull();
  });
});

describe('prompt_suggestion persistence', () => {
  it('is a transient frame, so it never reaches the raw message log', () => {
    expect(isTransientClaudeCodeFrame({ type: 'prompt_suggestion', suggestion: 'x' })).toBe(true);
  });
});
