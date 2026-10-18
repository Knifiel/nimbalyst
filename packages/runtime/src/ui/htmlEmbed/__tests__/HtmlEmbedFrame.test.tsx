/**
 * The host bridge in jsdom: the iframe is sandboxed without same-origin, the
 * author's HTML goes to the frame only after its own window says ready,
 * messages from any other window are ignored, and a navigate request reaches
 * the host opener only for safe hrefs.
 */

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';

import { HtmlEmbedFrame } from '../HtmlEmbedFrame';
import { HTML_EMBED_CHANNEL } from '../htmlEmbedProtocol';

const theme = { colorScheme: 'dark' as const, vars: { '--nim-bg': '#111' } };

function setup(props: Partial<React.ComponentProps<typeof HtmlEmbedFrame>> = {}) {
  const onNavigate = vi.fn();
  const view = render(
    <HtmlEmbedFrame html="<p>hi</p>" shellUrl="about:blank" onNavigate={onNavigate} theme={theme} {...props} />,
  );
  const iframe = view.container.querySelector('iframe') as HTMLIFrameElement;
  const frameWindow = iframe.contentWindow as Window;
  const posted = vi.spyOn(frameWindow, 'postMessage');
  const send = (data: unknown, source: MessageEventSource | null = frameWindow) =>
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data, source }));
    });
  return { view, iframe, frameWindow, posted, send, onNavigate };
}

const envelope = (fields: Record<string, unknown>) => ({ channel: HTML_EMBED_CHANNEL, v: 1, ...fields });

describe('HtmlEmbedFrame', () => {
  it('sandboxes the frame without same-origin', () => {
    const { iframe } = setup();
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts allow-popups');
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-same-origin');
  });

  it('renders once into its own frame after ready, with the theme', () => {
    const { posted, send } = setup();
    send(envelope({ type: 'ready' }));
    send(envelope({ type: 'ready' }));
    expect(posted).toHaveBeenCalledTimes(1);
    expect(posted).toHaveBeenCalledWith(envelope({ type: 'render', html: '<p>hi</p>', theme }), '*');
  });

  it('ignores messages from any other window', () => {
    const { posted, send, onNavigate } = setup();
    send(envelope({ type: 'ready' }), window);
    send(envelope({ type: 'navigate', href: 'Home.md' }), window);
    send(envelope({ type: 'navigate', href: 'Home.md' }), null);
    expect(posted).not.toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('opens safe hrefs and refuses javascript: and data:', () => {
    const { send, onNavigate } = setup();
    send(envelope({ type: 'navigate', href: 'javascript:parent.alert(1)', newTab: false }));
    send(envelope({ type: 'navigate', href: 'data:text/html,x' }));
    send(envelope({ type: 'navigate', href: 'nimbalyst://NIM-123', newTab: true }));
    send(envelope({ type: 'navigate', href: 'Modules/Sync.md' }));
    expect(onNavigate.mock.calls).toEqual([
      ['nimbalyst://NIM-123', { newTab: true, kind: 'nimbalyst' }],
      ['Modules/Sync.md', { newTab: false, kind: 'relative' }],
    ]);
  });

  it('follows reported height unless a fixed height is given', () => {
    const auto = setup();
    auto.send(envelope({ type: 'resize', height: 412 }));
    expect(auto.iframe.style.height).toBe('412px');
    auto.view.unmount();

    const fixed = setup({ height: 300 });
    fixed.send(envelope({ type: 'resize', height: 412 }));
    expect(fixed.iframe.style.height).toBe('300px');
  });

  it('sends live theme changes after rendering', () => {
    const { view, posted, send, onNavigate } = setup();
    send(envelope({ type: 'ready' }));
    const light = { colorScheme: 'light' as const, vars: { '--nim-bg': '#fff' } };
    view.rerender(<HtmlEmbedFrame html="<p>hi</p>" shellUrl="about:blank" onNavigate={onNavigate} theme={light} />);
    expect(posted).toHaveBeenLastCalledWith(envelope({ type: 'theme', theme: light }), '*');
  });
});
