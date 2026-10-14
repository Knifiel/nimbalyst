// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { LocalPage } from '@nimbalyst/local-wiki';
import { canvasCardPage } from '../canvas/canvasCardPages';

const page = (id: string, path: string, trashedAt: number | null = null) => ({ id, path, trashedAt }) as LocalPage;
const pages = [page('flow', 'Design/Flow.excalidraw'), page('old', 'Old.md', 1000)];
const roots = { wikiRoot: '/p/nimbalyst-local/wiki', projectRoot: '/p' };

describe('canvasCardPage', () => {
  it('finds the page a card names by project-relative, wiki-relative or absolute path, and nothing outside the wiki', () => {
    expect(canvasCardPage('nimbalyst-local/wiki/Design/Flow.excalidraw', pages, roots)?.id).toBe('flow');
    expect(canvasCardPage('Design/./Flow.excalidraw', pages, roots)?.id).toBe('flow');
    expect(canvasCardPage('/p/nimbalyst-local/wiki/Design/Flow.excalidraw', pages, roots)?.id).toBe('flow');
    expect(canvasCardPage('src/app.ts', pages, roots)).toBeNull();
    expect(canvasCardPage('Old.md', pages, roots)).toBeNull();
  });
});
