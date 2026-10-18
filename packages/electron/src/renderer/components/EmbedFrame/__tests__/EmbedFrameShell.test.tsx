/**
 * An HTML page embed is live before it is selected: no shield sits over it
 * and its editor is not inert, so a reader clicks straight into the page.
 * Every other page embed keeps the click-to-select shield.
 */

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';

import { EmbedFrameShell } from '../EmbedFrameShell';

function renderShell(interactive: boolean, attrs: Record<string, string> = {}) {
  return render(
    <LexicalComposer initialConfig={{ namespace: 'embed-shell-test', onError: (error) => { throw error; } }}>
      <EmbedFrameShell
        nodeKey="missing"
        attrs={attrs}
        label="Map"
        displayName="Map.html"
        onOpen={() => {}}
        markers={{}}
        loadingText="Loading"
        interactive={interactive}
      >
        <button type="button">inside</button>
      </EmbedFrameShell>
    </LexicalComposer>,
  );
}

describe('EmbedFrameShell', () => {
  it('leaves an interactive embed reachable without selecting it', () => {
    const { queryByTestId, container } = renderShell(true);
    expect(queryByTestId('embed-frame-shield')).toBeNull();
    expect(container.querySelector('.embed-frame__editor-host')!.hasAttribute('inert')).toBe(false);
  });

  it('keeps the click-to-select shield on other embeds', () => {
    const { queryByTestId, container } = renderShell(false);
    expect(queryByTestId('embed-frame-shield')).not.toBeNull();
    expect(container.querySelector('.embed-frame__editor-host')!.hasAttribute('inert')).toBe(true);
  });

  // F-R1-3: an HTML page embed with no `height=` grows to its content.
  it('lets an interactive embed without a height follow its content', () => {
    const { container } = renderShell(true);
    const body = container.querySelector<HTMLElement>('.embed-frame__body')!;
    expect(body.style.height).toBe('');
    expect(body.classList.contains('embed-frame__body--fit')).toBe(true);
  });

  it('keeps a set height, and the default height for other embeds', () => {
    expect(renderShell(true, { height: '300' }).container.querySelector<HTMLElement>('.embed-frame__body')!.style.height).toBe('300px');
    expect(renderShell(false).container.querySelector<HTMLElement>('.embed-frame__body')!.style.height).toBe('400px');
  });
});
