/**
 * Which built-in editor opens a page, and the editor page types the New page
 * menu offers. Pure functions of the inlined manifests, so they test without a
 * build.
 */
import type { BrowserExtensionManifest, BrowserExtensionNewFileContribution } from '@nimbalyst/web-editors/registry';

export interface WikiEditorMatch {
  extensionId: string;
  component: string;
  displayName: string;
}

export interface WikiNewPageType extends BrowserExtensionNewFileContribution {
  extensionId: string;
}

/**
 * The local wiki's editor page suffixes and the document type each is stored
 * as. Mirrors `DEFAULT_EDITOR_TYPES` in @nimbalyst/local-wiki, whose module is
 * Node-only; a test keeps the two equal.
 */
export const WIKI_EDITOR_PAGE_TYPES: Readonly<Record<string, string>> = {
  '.excalidraw': 'excalidraw',
  '.mindmap': 'mindmap',
  '.prisma': 'datamodel',
  '.mockup.html': 'mockup.html',
  '.csv': 'csv',
  '.calc.md': 'calc.md',
  '.canvas': 'canvas',
  '.html': 'html',
};

function suffixOf(pattern: string): string | null {
  return pattern.startsWith('*.') && !pattern.slice(2).includes('*') ? pattern.slice(1).toLowerCase() : null;
}

/** The editor whose file pattern matches a file name or suffix; the longest suffix wins (`.calc.md` over `.md`). */
export function matchEditor(manifests: readonly BrowserExtensionManifest[], fileName: string): WikiEditorMatch | null {
  const lower = fileName.toLowerCase();
  let best: (WikiEditorMatch & { suffix: string }) | null = null;
  for (const manifest of manifests) {
    for (const editor of manifest.contributions?.customEditors ?? []) {
      for (const pattern of editor.filePatterns) {
        const suffix = suffixOf(pattern);
        if (!suffix || !lower.endsWith(suffix)) continue;
        if (!best || suffix.length > best.suffix.length) {
          best = { extensionId: manifest.id, component: editor.component, displayName: editor.displayName, suffix };
        }
      }
    }
  }
  return best ? { extensionId: best.extensionId, component: best.component, displayName: best.displayName } : null;
}

/**
 * The page types the New page menu offers: each editor's own new-file entry,
 * kept only when the local wiki stores that suffix as an editor page.
 */
export function newPageTypes(manifests: readonly BrowserExtensionManifest[], wikiSuffixes: ReadonlySet<string>): WikiNewPageType[] {
  return manifests.flatMap((manifest) => (manifest.contributions?.newFileMenu ?? [])
    .filter((entry) => wikiSuffixes.has(entry.extension.toLowerCase()))
    .map((entry) => ({ ...entry, extensionId: manifest.id })));
}

/** A New page menu entry for each editor page type, in the docs host's descriptor shape. */
export function editorPageDescriptors(manifests: readonly BrowserExtensionManifest[]) {
  return newPageTypes(manifests, new Set(Object.keys(WIKI_EDITOR_PAGE_TYPES))).map((entry) => {
    const suffix = entry.extension.toLowerCase();
    const match = matchEditor(manifests, `x${suffix}`);
    const documentType = WIKI_EDITOR_PAGE_TYPES[suffix]!;
    return {
      documentType,
      displayName: entry.displayName,
      fileExtensions: [suffix],
      defaultExtension: suffix,
      icon: entry.icon,
      editor: { kind: 'extension' as const, extensionId: entry.extensionId, ...(match ? { componentName: match.component } : {}) },
      content: { strategy: 'text' as const, codecId: documentType },
      creation: { defaultContent: entry.defaultContent ?? '', source: 'newFileMenu' as const },
      capabilities: { localCreate: true, shareToTeam: false, sharedCreate: true, history: false, export: false },
    };
  });
}

/** `.excalidraw`, `.mockup.html`, ... from the editors' `*.<suffix>` file patterns. */
export function embeddableSuffixes(manifests: readonly BrowserExtensionManifest[]): string[] {
  const suffixes = new Set<string>();
  for (const manifest of manifests) {
    for (const editor of manifest.contributions?.customEditors ?? []) {
      for (const pattern of editor.filePatterns ?? []) {
        if (/^\*\.[^*/]+$/.test(pattern)) suffixes.add(pattern.slice(1).toLowerCase());
      }
    }
  }
  return [...suffixes];
}
