import { describe, expect, it } from 'vitest';
import { renderMermaid } from '../mermaidRender';

describe('renderMermaid', () => {
  it('preserves the edge group used by SVG styles when rendering a flowchart', async () => {
    // jsdom lacks SVG measurements. Geometry is deliberately not asserted here;
    // this exercises Mermaid's real renderer and the selectors in its emitted SVG.
    const bbox = Object.getOwnPropertyDescriptor(SVGElement.prototype, 'getBBox');
    Object.defineProperty(SVGElement.prototype, 'getBBox', {
      configurable: true,
      value: () => ({ x: 0, y: 0, width: 80, height: 20 }),
    });
    try {
      const { svg } = await renderMermaid('mermaid_edges_test', 'flowchart TD\n A --> B', false);
      const rendered = new DOMParser().parseFromString(svg, 'image/svg+xml');
      expect(rendered.querySelector('.edgePaths path')).not.toBeNull();
      expect(rendered.querySelector('style')?.textContent).toContain('.edgePaths .path');
    } finally {
      if (bbox) Object.defineProperty(SVGElement.prototype, 'getBBox', bbox);
      else delete (SVGElement.prototype as any).getBBox;
    }
  });

  // A gantt drawn on document.body takes the window's width and is then scaled
  // down to the document column, shrinking its text with it.
  it('draws a gantt at the width of the element it is shown in', async () => {
    const target = document.createElement('div');
    target.className = 'mermaid-render-container';
    document.body.appendChild(target);
    const props = ['getBBox', 'getComputedTextLength'] as const;
    const saved = props.map((p) => Object.getOwnPropertyDescriptor(SVGElement.prototype, p));
    const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    const offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
    Object.defineProperty(SVGElement.prototype, 'getBBox', {
      configurable: true,
      value: () => ({ x: 0, y: 0, width: 80, height: 20 }),
    });
    Object.defineProperty(SVGElement.prototype, 'getComputedTextLength', { configurable: true, value: () => 80 });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get() { return this === target ? 640 : 0; },
    });
    // Mermaid reads the width of the div it draws in; the window is wider.
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get() { return this.parentElement === document.body ? 1280 : parseInt(this.parentElement?.style.width || '0', 10); },
    });
    try {
      const { svg } = await renderMermaid(
        'mermaid_gantt_width_test',
        'gantt\n dateFormat YYYY-MM-DD\n section Active\n Build app :a1, 2026-08-01, 2026-11-15',
        false,
        target,
      );
      const rendered = new DOMParser().parseFromString(svg, 'image/svg+xml');
      expect(rendered.documentElement.getAttribute('viewBox')).toMatch(/^0 0 640 /);
      expect(document.body.querySelectorAll('[style*="visibility:hidden"], [style*="visibility: hidden"]')).toHaveLength(0);
    } finally {
      props.forEach((p, i) => {
        if (saved[i]) Object.defineProperty(SVGElement.prototype, p, saved[i]!);
        else delete (SVGElement.prototype as any)[p];
      });
      if (clientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientWidth);
      if (offsetWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', offsetWidth);
      target.remove();
    }
  });

  // A leaked temp container stays in document.body below the app root, makes the
  // document taller than the viewport, and lets scrollIntoView push the window
  // title bar off-screen.
  it('leaves nothing in document.body when the diagram fails to parse', async () => {
    const elementId = 'mermaid_leak_test';
    const bodyChildrenBefore = document.body.children.length;

    await expect(
      renderMermaid(elementId, 'flowchart TD\n  A --> B\n  B -->> ((', false),
    ).rejects.toBeTruthy();

    expect(document.getElementById(`d${elementId}`)).toBeNull();
    expect(document.getElementById(elementId)).toBeNull();
    expect(document.body.children.length).toBe(bodyChildrenBefore);
  });
});
