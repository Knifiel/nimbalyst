// @vitest-environment node

/**
 * KaTeX renders untrusted LaTeX from documents and agent transcripts. The
 * pinned major moves under a pnpm override (GHSA-238p-pmpm-9mq7), so this
 * guards what the extension relies on: equations render, and `trust: false`
 * still refuses links and images an author could smuggle in.
 */

import { describe, expect, it } from 'vitest';
import { renderMathMarkup } from '../renderMath';

describe('renderMathMarkup', () => {
  it('renders inline and display equations as KaTeX markup', () => {
    expect(renderMathMarkup('\\frac{a}{b}', false)).toContain('class="mfrac"');
    expect(renderMathMarkup('x^2', true)).toContain('class="katex-display"');
  });

  it('never emits a link or image from untrusted source', () => {
    const link = renderMathMarkup('\\href{javascript:alert(1)}{click}', false);
    expect(link).not.toMatch(/<a\b/);
    expect(link).not.toContain('javascript:');
    expect(renderMathMarkup('\\includegraphics{https://example.com/x.png}', false)).not.toMatch(/<img\b/);
  });
});
