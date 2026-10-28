import type { LexicalEditor } from 'lexical';
import { $getNodeByKey, $isTextNode } from 'lexical';
import { resolveMatchRange } from './resolveMatchRange';

export interface SearchMatch {
  key: string;
  offset: number;
  length: number;
  text: string;
}

// Highlights are one DOM element per match. A one-letter query on a long page matches tens
// of thousands of times, so only a window of matches around the current one is drawn. Every
// match is still counted and reachable with next/previous, which moves the window.
export const MAX_RENDERED_HIGHLIGHTS = 1000;

function getHighlightWindow(matchCount: number, currentIndex: number): [start: number, end: number] {
  if (matchCount <= MAX_RENDERED_HIGHLIGHTS) return [0, matchCount];
  const centered = Math.max(currentIndex, 0) - MAX_RENDERED_HIGHLIGHTS / 2;
  const start = Math.min(Math.max(centered, 0), matchCount - MAX_RENDERED_HIGHLIGHTS);
  return [start, start + MAX_RENDERED_HIGHLIGHTS];
}

// HighlightManager class for creating visual highlights over search matches
export class HighlightManager {
  private editor: LexicalEditor;
  private highlightElements: HTMLElement[] = [];
  private wrapperElement: HTMLElement;
  private observer: MutationObserver | null = null;
  private rootElement: HTMLElement | null = null;
  private parentElement: HTMLElement | null = null;

  constructor(editor: LexicalEditor) {
    this.editor = editor;
    this.wrapperElement = document.createElement('div');
    this.wrapperElement.className = 'search-highlights-wrapper';
    this.wrapperElement.style.position = 'relative';
    this.wrapperElement.style.pointerEvents = 'none';
  }

  updateHighlights(matches: SearchMatch[], currentIndex: number) {
    const rootElement = this.editor.getRootElement();
    if (!rootElement) return;

    const parentElement = rootElement.parentElement;
    if (!parentElement) return;

    if (this.rootElement !== rootElement || this.parentElement !== parentElement) {
      this.setupObserver(rootElement, parentElement);
    }

    this.clearHighlights();

    if (!this.wrapperElement.isConnected) {
      parentElement.insertBefore(this.wrapperElement, parentElement.firstChild);
    }

    const { left: parentLeft, top: parentTop } = parentElement.getBoundingClientRect();

    // Read every rect first, then write every highlight. Interleaving a layout read
    // (getClientRects) with a DOM write per match recomputes layout once per match, which
    // froze the renderer for seconds on a long page with a short query.
    const [start, end] = getHighlightWindow(matches.length, currentIndex);
    const pending: Array<{ rect: DOMRect; isCurrent: boolean }> = [];

    this.editor.getEditorState().read(() => {
      for (let index = start; index < end; index++) {
        const match = matches[index];
        const node = $getNodeByKey(match.key);
        if (!$isTextNode(node)) continue;

        // Validate offset is still valid for this node
        const textContent = node.getTextContent();
        if (match.offset >= textContent.length) continue;

        const domElement = this.editor.getElementByKey(match.key);
        if (!domElement) continue;

        // Not every TextNode renders as a single text child — inline code renders as
        // <code><span class="nim-text-code">…</span></code> — so walk descendant text nodes.
        const range = resolveMatchRange(domElement, match.offset, match.length);
        if (!range) continue;

        for (const rect of Array.from(range.getClientRects())) {
          pending.push({ rect, isCurrent: index === currentIndex });
        }
      }
    });

    const fragment = document.createDocumentFragment();
    for (const { rect, isCurrent } of pending) {
      const highlightElement = document.createElement('div');
      highlightElement.className = isCurrent ? 'search-highlight-current' : 'search-highlight';
      highlightElement.style.position = 'absolute';
      highlightElement.style.left = `${rect.left - parentLeft}px`;
      highlightElement.style.top = `${rect.top - parentTop}px`;
      highlightElement.style.width = `${rect.width}px`;
      highlightElement.style.height = `${rect.height}px`;
      highlightElement.style.pointerEvents = 'none';

      fragment.appendChild(highlightElement);
      this.highlightElements.push(highlightElement);
    }
    this.wrapperElement.appendChild(fragment);
  }

  clearHighlights() {
    this.highlightElements.forEach((element) => element.remove());
    this.highlightElements = [];
  }

  destroy() {
    this.clearHighlights();
    this.wrapperElement.remove();
    if (this.observer) {
      this.observer.disconnect();
    }
  }

  private setupObserver(rootElement: HTMLElement, parentElement: HTMLElement) {
    if (this.observer) {
      this.observer.disconnect();
    }

    this.rootElement = rootElement;
    this.parentElement = parentElement;

    this.observer = new MutationObserver(() => {
      const currentRoot = this.editor.getRootElement();
      const currentParent = currentRoot?.parentElement;

      if (currentRoot !== this.rootElement || currentParent !== this.parentElement) {
        this.clearHighlights();
      }
    });

    this.observer.observe(parentElement, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
  }
}
