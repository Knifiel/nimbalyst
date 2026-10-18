/**
 * Mermaid loading and rendering, kept free of React/Lexical so it can be
 * tested against the real mermaid library.
 */

// Dynamic import to avoid bundling mermaid when not needed
let mermaidModule: any = null;
let mermaidLoadPromise: Promise<any> | null = null;
let lastInitTheme: string | null = null;

export async function loadMermaid(isDarkTheme: boolean): Promise<any> {
  const themeKey = isDarkTheme ? 'dark' : 'light';

  if (!mermaidLoadPromise) {
    mermaidLoadPromise = (async () => {
      const module = await import('mermaid');
      const mermaid = module.default || (module as any).mermaid || module;
      if (typeof mermaid.initialize !== 'function') {
        console.error('Invalid mermaid instance:', mermaid);
        throw new Error('Failed to load mermaid module');
      }
      mermaidModule = mermaid;
      return mermaid;
    })();
  }

  await mermaidLoadPromise;

  if (lastInitTheme !== themeKey) {
    lastInitTheme = themeKey;
    mermaidModule.initialize({
      startOnLoad: false,
      theme: isDarkTheme ? 'dark' : 'default',
      securityLevel: 'antiscript',
      fontFamily: 'monospace',
      // Without this, a parse failure draws mermaid's error SVG into a temp
      // container on document.body and never removes it. Leaked containers make
      // the document taller than the window, and a scrollIntoView then scrolls
      // the title bar off-screen. MermaidDiagram shows its own error UI instead.
      suppressErrorRendering: true,
      // Gantt active/done/crit labels use this color through an id-scoped
      // !important rule that mermaidGantt.css cannot outrank. The bars there
      // are tints of the page background, so the label needs the page's text
      // color, which the dark theme's default (near black) is not.
      themeVariables: { taskTextDarkColor: isDarkTheme ? '#e5e7eb' : '#111827' },
      // Mermaid's gantt defaults (11px text, 20px bars) are sized for a wide
      // standalone page and are unreadable in a document column. Colors and
      // fonts are mapped to --nim-* in mermaidGantt.css.
      gantt: {
        fontSize: 14,
        sectionFontSize: 14,
        barHeight: 28,
        barGap: 8,
        topPadding: 56,
        leftPadding: 120,
        rightPadding: 40,
        gridLineStartPadding: 40,
      },
    });
  }

  return mermaidModule;
}

/**
 * Gantt charts take their width from the element they are drawn in, and the
 * SVG is then scaled to fit the page. Drawn on document.body, a chart is as
 * wide as the window, so in a narrower document column everything, text
 * included, shrinks. Drawing in a hidden host as wide as the target keeps the
 * chart at 1:1. The host copies the target's classes so text is measured with
 * the same CSS it is displayed with.
 */
function createSizedHost(target: HTMLElement): HTMLElement | undefined {
  const width = target.clientWidth;
  if (!width) return undefined;
  const host = document.createElement('div');
  host.className = target.className;
  host.style.cssText = `position:absolute;left:0;top:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none;width:${width}px;`;
  (target.parentElement ?? document.body).appendChild(host);
  return host;
}

export async function renderMermaid(
  elementId: string,
  content: string,
  isDarkTheme: boolean,
  sizeTo?: HTMLElement | null,
): Promise<{ svg: string; bindFunctions?: (element: Element) => void }> {
  const mermaid = await loadMermaid(isDarkTheme);
  const host = sizeTo ? createSizedHost(sizeTo) : undefined;
  try {
    return await mermaid.render(elementId, content, host);
  } catch (err) {
    // Backstop for failure paths that bypass mermaid's own temp cleanup.
    document.getElementById(`d${elementId}`)?.remove();
    document.getElementById(elementId)?.remove();
    throw err;
  } finally {
    host?.remove();
  }
}
