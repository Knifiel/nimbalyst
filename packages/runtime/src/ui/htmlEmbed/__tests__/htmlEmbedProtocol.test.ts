// @vitest-environment node
/**
 * The host side of the HTML embed bridge trusts nothing the frame sends. A
 * navigate href reaches the app's openers only when it is a web URL, a
 * nimbalyst: link, or a relative path; anything a browser would run or load
 * as a scheme (javascript:, data:, file:, obfuscated variants) is refused.
 */

import { describe, expect, it } from 'vitest';

import {
  HTML_EMBED_CHANNEL,
  HTML_EMBED_MAX_HEIGHT,
  classifyEmbedHref,
  clampEmbedHeight,
  readHtmlEmbedMessage,
} from '../htmlEmbedProtocol';

describe('classifyEmbedHref', () => {
  it('accepts web, nimbalyst and relative links', () => {
    expect(classifyEmbedHref('https://example.com/a?b=1')).toEqual({ kind: 'web', href: 'https://example.com/a?b=1' });
    expect(classifyEmbedHref('http://example.com')).toEqual({ kind: 'web', href: 'http://example.com' });
    expect(classifyEmbedHref('nimbalyst://NIM-123')).toEqual({ kind: 'nimbalyst', href: 'nimbalyst://NIM-123' });
    expect(classifyEmbedHref('Modules/Sync.md')).toEqual({ kind: 'relative', href: 'Modules/Sync.md' });
    expect(classifyEmbedHref('../Home.md#top')).toEqual({ kind: 'relative', href: '../Home.md#top' });
    expect(classifyEmbedHref('/docs/plan.md')).toEqual({ kind: 'relative', href: '/docs/plan.md' });
    expect(classifyEmbedHref('  Home.md  ')).toEqual({ kind: 'relative', href: 'Home.md' });
  });

  it('refuses script, data and other schemes, including obfuscated ones', () => {
    for (const href of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      ' javascript:alert(1)',
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      '\u0001javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'blob:https://example.com/123',
      'about:blank',
      'mailto:a@b.c',
    ]) {
      expect(classifyEmbedHref(href), href).toBeNull();
    }
  });

  it('refuses scheme-relative and backslash hosts that resolve off the page', () => {
    for (const href of ['//evil.example/x', '\\\\evil.example\\x', '/\\evil.example', '\\/evil.example']) {
      expect(classifyEmbedHref(href), href).toBeNull();
    }
  });

  it('ignores empty and in-page anchors', () => {
    expect(classifyEmbedHref('')).toBeNull();
    expect(classifyEmbedHref('   ')).toBeNull();
    expect(classifyEmbedHref('#section')).toBeNull();
    expect(classifyEmbedHref(42 as unknown as string)).toBeNull();
  });
});

describe('readHtmlEmbedMessage', () => {
  it('reads the three shell-to-host messages', () => {
    expect(readHtmlEmbedMessage({ channel: HTML_EMBED_CHANNEL, v: 1, type: 'ready' })).toEqual({ type: 'ready' });
    expect(readHtmlEmbedMessage({ channel: HTML_EMBED_CHANNEL, v: 1, type: 'resize', height: 320.4 })).toEqual({ type: 'resize', height: 321 });
    expect(readHtmlEmbedMessage({ channel: HTML_EMBED_CHANNEL, v: 1, type: 'navigate', href: 'Home.md', newTab: 1 })).toEqual({
      type: 'navigate',
      href: 'Home.md',
      newTab: true,
    });
  });

  it('drops anything off the channel, the wrong version, or malformed', () => {
    expect(readHtmlEmbedMessage(null)).toBeNull();
    expect(readHtmlEmbedMessage('ready')).toBeNull();
    expect(readHtmlEmbedMessage({ channel: 'other', v: 1, type: 'ready' })).toBeNull();
    expect(readHtmlEmbedMessage({ channel: HTML_EMBED_CHANNEL, v: 2, type: 'ready' })).toBeNull();
    expect(readHtmlEmbedMessage({ channel: HTML_EMBED_CHANNEL, v: 1, type: 'render', html: '<p>' })).toBeNull();
    expect(readHtmlEmbedMessage({ channel: HTML_EMBED_CHANNEL, v: 1, type: 'resize', height: 'tall' })).toBeNull();
    expect(readHtmlEmbedMessage({ channel: HTML_EMBED_CHANNEL, v: 1, type: 'resize', height: Number.NaN })).toBeNull();
    expect(readHtmlEmbedMessage({ channel: HTML_EMBED_CHANNEL, v: 1, type: 'navigate', href: 7 })).toBeNull();
  });

  it('clamps heights a frame reports', () => {
    expect(clampEmbedHeight(-50)).toBe(0);
    expect(clampEmbedHeight(10_000_000)).toBe(HTML_EMBED_MAX_HEIGHT);
  });
});
