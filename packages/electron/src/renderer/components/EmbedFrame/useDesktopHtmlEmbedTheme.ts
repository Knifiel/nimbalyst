/**
 * The app's current theme as an HTML embed theme: light/dark plus every
 * `--nim-*` value. `applyThemeToDOM` writes the variables asynchronously, so
 * this re-reads them whenever the root element's theme attributes change
 * rather than when the theme id does.
 */

import { useEffect, useState } from 'react';
import {
  htmlEmbedThemeKey,
  readHtmlEmbedTheme,
} from '@nimbalyst/runtime/ui/htmlEmbed/htmlEmbedTheme';
import type { HtmlEmbedTheme } from '@nimbalyst/runtime/ui/htmlEmbed/htmlEmbedProtocol';

import { useTheme } from '../../hooks/useTheme';

export function useDesktopHtmlEmbedTheme(): HtmlEmbedTheme {
  const { theme } = useTheme();
  const colorScheme = theme === 'dark' ? 'dark' : 'light';
  const [embedTheme, setEmbedTheme] = useState(() => readHtmlEmbedTheme(colorScheme));

  useEffect(() => {
    let frame = 0;
    const refresh = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next = readHtmlEmbedTheme(colorScheme);
        setEmbedTheme((previous) => (htmlEmbedThemeKey(previous) === htmlEmbedThemeKey(next) ? previous : next));
      });
    };
    refresh();
    const observer = new MutationObserver(refresh);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-theme'] });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [colorScheme]);

  return embedTheme;
}
