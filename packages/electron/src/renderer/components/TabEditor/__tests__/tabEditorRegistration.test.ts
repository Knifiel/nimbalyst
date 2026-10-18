// @vitest-environment node

/**
 * A Local wiki `.html` page opens in the HTML page editor, whose links route
 * to wiki pages; any other workspace `.html` file keeps the Browser editor.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustomEditorRegistration } from '../../CustomEditors/types';

vi.mock('../../CustomEditors', () => ({ customEditorRegistry: { findRegistrationForFile: vi.fn() } }));
const wikiFiles = new Map<string, string>();
vi.mock('../../../store/atoms/collabDocuments', () => ({
  getPersonalCollabHost: () => ({ source: () => ({ documentIdForFile: (path: string) => wikiFiles.get(path) ?? null }) }),
}));

import { customEditorRegistry } from '../../CustomEditors';
import { HTML_PAGE_EDITOR_REGISTRATION } from '../../HtmlPage/htmlPageRegistration';
import { findTabEditorRegistration } from '../tabEditorRegistration';

const WORKSPACE = '/repo';
const editor = (extensions: string[], extensionId: string): CustomEditorRegistration => ({
  extensions,
  component: (() => null) as unknown as CustomEditorRegistration['component'],
  extensionId,
});
const browser = editor(['.html', '.htm'], 'com.nimbalyst.browser');
const mockup = editor(['.mockup.html'], 'com.nimbalyst.mockuplm');

describe('findTabEditorRegistration', () => {
  beforeEach(() => {
    wikiFiles.clear();
    wikiFiles.set('/repo/nimbalyst-local/wiki/HTML link test.html', 'page-1');
    wikiFiles.set('/repo/nimbalyst-local/wiki/Board.mockup.html', 'page-2');
    vi.mocked(customEditorRegistry.findRegistrationForFile).mockImplementation((path) =>
      path.endsWith('.mockup.html') ? mockup : path.endsWith('.html') ? browser : undefined);
  });

  it('opens a Local wiki html page in the HTML page editor', () => {
    expect(findTabEditorRegistration('/repo/nimbalyst-local/wiki/HTML link test.html', WORKSPACE))
      .toBe(HTML_PAGE_EDITOR_REGISTRATION);
  });

  it('keeps the Browser editor for a workspace html file that is not a wiki page', () => {
    expect(findTabEditorRegistration('/repo/site/index.html', WORKSPACE)).toBe(browser);
  });

  it('keeps the Browser editor when the tab has no workspace', () => {
    expect(findTabEditorRegistration('/repo/nimbalyst-local/wiki/HTML link test.html', undefined)).toBe(browser);
  });

  it('keeps a compound-extension editor for a wiki file such as a mockup', () => {
    expect(findTabEditorRegistration('/repo/nimbalyst-local/wiki/Board.mockup.html', WORKSPACE)).toBe(mockup);
  });
});
