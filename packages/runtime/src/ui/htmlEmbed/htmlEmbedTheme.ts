/**
 * Collects the host's `--nim-*` custom properties for an HTML embed, so a
 * diagram can match the app with `var(--nim-bg)`.
 */

import type { HtmlEmbedTheme } from './htmlEmbedProtocol';

const NIM_VAR = /^--nim-[A-Za-z0-9_-]+$/;

function declaredNimVarNames(doc: Document): Set<string> {
  const names = new Set<string>();
  const visit = (rules: CSSRuleList | undefined) => {
    if (!rules) return;
    for (const rule of Array.from(rules)) {
      const style = (rule as CSSStyleRule).style;
      if (style) {
        for (let i = 0; i < style.length; i++) {
          const name = style[i];
          if (name && NIM_VAR.test(name)) names.add(name);
        }
      }
      const nested = (rule as CSSGroupingRule).cssRules;
      if (nested) visit(nested);
    }
  };
  for (const sheet of Array.from(doc.styleSheets)) {
    try {
      visit(sheet.cssRules);
    } catch {
      // Cross-origin stylesheet; it declares no --nim-* variables we own.
    }
  }
  return names;
}

/**
 * Reads the computed value of every `--nim-*` variable on `element`
 * (default: the document root) plus the color scheme.
 */
export function readHtmlEmbedTheme(colorScheme: 'light' | 'dark', element?: Element): HtmlEmbedTheme {
  const target = element ?? (typeof document !== 'undefined' ? document.documentElement : null);
  if (!target) return { colorScheme, vars: {} };
  const doc = target.ownerDocument;
  const computed = doc.defaultView?.getComputedStyle(target);
  const names = declaredNimVarNames(doc);
  const inline = (target as HTMLElement).style;
  if (inline) {
    for (let i = 0; i < inline.length; i++) {
      const name = inline[i];
      if (name && NIM_VAR.test(name)) names.add(name);
    }
  }
  if (computed) {
    for (let i = 0; i < computed.length; i++) {
      const name = computed[i];
      if (name && NIM_VAR.test(name)) names.add(name);
    }
  }
  const vars: Record<string, string> = {};
  for (const name of names) {
    const value = computed?.getPropertyValue(name).trim();
    if (value) vars[name] = value;
  }
  return { colorScheme, vars };
}

export function htmlEmbedThemeKey(theme: HtmlEmbedTheme): string {
  return JSON.stringify([theme.colorScheme, Object.entries(theme.vars).sort(([a], [b]) => (a < b ? -1 : 1))]);
}
