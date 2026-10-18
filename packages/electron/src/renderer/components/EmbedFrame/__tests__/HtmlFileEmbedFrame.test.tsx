/**
 * F-R1-2: a relative link in an embedded HTML file resolves beside the HTML
 * file, not beside the page that embeds it, so `./Module.md` in
 * `Maps/Map.html` names `Maps/Module.md` wherever the map is shown.
 */

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';

const navigation = vi.hoisted(() => ({ open: vi.fn() }));

vi.mock('../htmlEmbedNavigation', () => ({
  openHtmlEmbedLink: navigation.open,
  htmlLinkBaseFor: (path: string | null) => ({ kind: 'file', path }),
}));
vi.mock('../useEmbedFilePath', () => ({ useEmbedFilePath: () => ({ path: '/ws/Maps/Map.html', pending: false, error: null }) }));
vi.mock('../embeddedFileIo', () => ({
  readFileFromDisk: async () => '<a href="./Module.md">Module</a>',
  openFileInTab: vi.fn(),
  workspaceRelativePath: (path: string) => path,
}));
vi.mock('../../../services/document-model/DiskChangeSubscription', () => ({
  DiskChangeSubscription: class { dispose() {} },
}));
vi.mock('../useDesktopHtmlEmbedTheme', () => ({ useDesktopHtmlEmbedTheme: () => ({ colorScheme: 'dark', vars: {} }) }));
vi.mock('@nimbalyst/runtime/DocumentPathContext', () => ({
  useDocumentPath: () => ({ documentDir: '/ws', documentPath: '/ws/Home.md' }),
}));
vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({ MaterialSymbol: () => null }));

import { HtmlFileEmbedFrame } from '../HtmlFileEmbedFrame';

describe('HtmlFileEmbedFrame', () => {
  it('resolves relative links against the HTML file, not the embedding page', async () => {
    const { container } = render(
      <LexicalComposer initialConfig={{ namespace: 'html-file-embed-test', onError: (error) => { throw error; } }}>
        <HtmlFileEmbedFrame src="Maps/Map.html" label="Map" attrs={{}} nodeKey="missing" />
      </LexicalComposer>,
    );
    const iframe = await waitFor(() => {
      const found = container.querySelector('iframe');
      if (!found) throw new Error('no frame yet');
      return found;
    });
    // The frame can be in the DOM before the effect that listens for its
    // messages has run, so keep posting until the host has heard one.
    await waitFor(() => {
      act(() => {
        window.dispatchEvent(new MessageEvent('message', {
          source: iframe.contentWindow,
          data: { channel: 'nimbalyst-html-embed', v: 1, type: 'navigate', href: './Module.md', newTab: false },
        }));
      });
      expect(navigation.open).toHaveBeenCalledWith(
        './Module.md',
        { newTab: false, kind: 'relative' },
        { kind: 'file', path: '/ws/Maps/Map.html' },
      );
    });
  });
});
