import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Every key maps to the same text node; the DOM element for a key is a real <span> we control.
vi.mock('lexical', () => ({
  $getNodeByKey: () => ({ getTextContent: () => 'e'.repeat(10) }),
  $isTextNode: () => true,
}));

import { HighlightManager, MAX_RENDERED_HIGHLIGHTS, type SearchMatch } from '../HighlightManager';

function setup(matchCount: number) {
  const parent = document.createElement('div');
  const root = document.createElement('div');
  parent.appendChild(root);
  document.body.appendChild(parent);

  const spans = new Map<string, HTMLElement>();
  const matches: SearchMatch[] = [];
  for (let i = 0; i < matchCount; i++) {
    const key = `k${i}`;
    const span = document.createElement('span');
    span.textContent = 'e'.repeat(10);
    root.appendChild(span);
    spans.set(key, span);
    matches.push({ key, offset: 0, length: 1, text: 'e' });
  }

  const editor = {
    getRootElement: () => root,
    getEditorState: () => ({ read: (fn: () => void) => fn() }),
    getElementByKey: (key: string) => spans.get(key) ?? null,
  } as any;

  return { parent, matches, manager: new HighlightManager(editor) };
}

describe('HighlightManager.updateHighlights', () => {
  let wrapperChildCountAtRead: number[];
  let wrapper: () => Element | null;

  beforeEach(() => {
    wrapperChildCountAtRead = [];
    wrapper = () => document.querySelector('.search-highlights-wrapper');
    // jsdom has no layout; report one rect per range and record how many highlights are
    // already in the DOM each time layout would be read.
    (Range.prototype as any).getClientRects = function () {
      wrapperChildCountAtRead.push(wrapper()?.childElementCount ?? 0);
      return [{ left: 10, top: 20, width: 5, height: 12 }];
    };
  });

  afterEach(() => {
    document.body.innerHTML = '';
    delete (Range.prototype as any).getClientRects;
  });

  it('reads every match rect before adding any highlight element', () => {
    const { manager, matches } = setup(40);

    manager.updateHighlights(matches, 0);

    expect(wrapperChildCountAtRead).toHaveLength(40);
    // A read that follows a write forces a synchronous layout per match.
    expect(new Set(wrapperChildCountAtRead)).toEqual(new Set([0]));
    expect(wrapper()?.childElementCount).toBe(40);
  });

  it('renders a bounded window of highlights around the current match', () => {
    const total = MAX_RENDERED_HIGHLIGHTS * 3;
    const current = total / 2;
    const { manager, matches } = setup(total);

    manager.updateHighlights(matches, current);

    expect(wrapper()?.childElementCount).toBe(MAX_RENDERED_HIGHLIGHTS);
    expect(wrapper()?.querySelectorAll('.search-highlight-current')).toHaveLength(1);
  });

  it('keeps the window inside the match list at both ends', () => {
    const total = MAX_RENDERED_HIGHLIGHTS * 2;
    const { manager, matches } = setup(total);

    manager.updateHighlights(matches, 0);
    expect(wrapper()?.childElementCount).toBe(MAX_RENDERED_HIGHLIGHTS);
    expect(wrapper()?.querySelectorAll('.search-highlight-current')).toHaveLength(1);

    manager.updateHighlights(matches, total - 1);
    expect(wrapper()?.childElementCount).toBe(MAX_RENDERED_HIGHLIGHTS);
    expect(wrapper()?.querySelectorAll('.search-highlight-current')).toHaveLength(1);
  });
});
