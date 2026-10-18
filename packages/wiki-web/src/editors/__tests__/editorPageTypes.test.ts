// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DEFAULT_EDITOR_TYPES } from '@nimbalyst/local-wiki';
import type { BrowserExtensionManifest } from '@nimbalyst/web-editors/registry';
import calcSheets from '../../../../extensions/calc-sheets/manifest.json';
import csv from '../../../../extensions/csv-spreadsheet/manifest.json';
import datamodel from '../../../../extensions/datamodellm/manifest.json';
import excalidraw from '../../../../extensions/excalidraw/manifest.json';
import mockup from '../../../../extensions/mockuplm/manifest.json';
import { editorPageDescriptors, embeddableSuffixes, matchEditor, WIKI_EDITOR_PAGE_TYPES } from '../editorPageTypes';
import { HTML_PAGE_MANIFEST } from '../html/htmlPages';

// The mind map editor has its own repo; the live check covers it.
const manifests = [calcSheets, csv, datamodel, excalidraw, mockup, HTML_PAGE_MANIFEST] as unknown as BrowserExtensionManifest[];

describe('editor page types', () => {
  it('match the local wiki suffix table, and each one opens in and is created from a built-in editor', () => {
    expect(WIKI_EDITOR_PAGE_TYPES).toEqual(DEFAULT_EDITOR_TYPES);

    expect(matchEditor(manifests, 'Budget.calc.md')?.component).toBe('CalcSheetEditor');
    expect(matchEditor(manifests, 'Notes.md')).toBeNull();
    // The longest suffix wins: a mockup is not an HTML page.
    expect(matchEditor(manifests, 'Screen.mockup.html')?.extensionId).toBe('com.nimbalyst.mockuplm');
    expect(matchEditor(manifests, 'Product map.html')?.component).toBe('HtmlPageEditor');

    const created = editorPageDescriptors(manifests).map((descriptor) => [descriptor.defaultExtension, descriptor.documentType, descriptor.editor.componentName]);
    const expected = Object.entries(WIKI_EDITOR_PAGE_TYPES)
      // The mind map has its own repo; canvas is the app's own manifest, not an extension's.
      .filter(([suffix]) => suffix !== '.mindmap' && suffix !== '.canvas')
      .map(([suffix, documentType]) => [suffix, documentType, matchEditor(manifests, `x${suffix}`)?.component]);
    expect(created.sort()).toEqual(expected.sort());
    for (const [, , component] of created) expect(component).toBeTruthy();
  });

  it('declares every file a built-in editor opens as embeddable, so an embed link in a page loads as an embed', () => {
    expect(embeddableSuffixes(manifests)).toEqual(expect.arrayContaining(['.excalidraw', '.mockup.html', '.prisma', '.csv', '.calc.md']));
    expect(embeddableSuffixes(manifests)).not.toContain('.md');
  });
});
