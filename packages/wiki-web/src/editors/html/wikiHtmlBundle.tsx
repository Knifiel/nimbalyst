/**
 * The HTML page editor, loaded the first time an `.html` page opens: the page
 * live in the HTML embed sandbox, with a toggle to its source in Monaco.
 * Monaco stays mounted in both modes because it loads and saves the file
 * through the host; the preview follows its model.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { EditorHostProps } from '@nimbalyst/extension-sdk';
import { MonacoEditor } from '@nimbalyst/runtime';
import { HtmlEmbedFrame } from '@nimbalyst/runtime-source/ui/htmlEmbed/HtmlEmbedFrame';
import { navigateFromHtml, useWikiHtmlEmbedTheme, WIKI_HTML_EMBED_SHELL_URL } from './htmlPages';

const PREVIEW_DEBOUNCE_MS = 400;

function WikiHtmlPageEditor({ host }: EditorHostProps) {
  const [mode, setMode] = useState<'preview' | 'source'>('preview');
  const [html, setHtml] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const theme = useWikiHtmlEmbedTheme();

  const update = useCallback((next: string, immediate = false) => {
    if (timer.current) clearTimeout(timer.current);
    if (immediate) setHtml(next);
    else timer.current = setTimeout(() => setHtml(next), PREVIEW_DEBOUNCE_MS);
  }, []);

  useEffect(() => {
    let live = true;
    host.loadContent().then((content) => {
      if (live && typeof content === 'string') update(content, true);
    }).catch(() => {});
    const unsubscribe = host.onFileChanged((content) => update(content, true));
    return () => {
      live = false;
      unsubscribe();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [host, update]);

  const listener = useRef<{ dispose(): void } | null>(null);
  const onEditorReady = useCallback((wrapper: { editor?: unknown } | null) => {
    const editor = (wrapper?.editor ?? wrapper) as { getValue?: () => string; onDidChangeModelContent?: (fn: () => void) => { dispose(): void } } | null;
    if (!editor?.getValue || !editor.onDidChangeModelContent) return;
    listener.current?.dispose();
    const getValue = editor.getValue.bind(editor);
    listener.current = editor.onDidChangeModelContent(() => update(getValue()));
  }, [update]);
  useEffect(() => () => listener.current?.dispose(), []);

  return (
    <div className="wiki-web-html-page flex h-full min-h-0 flex-col" data-mode={mode}>
      <div className="flex gap-1 border-b border-nim px-3 py-1.5 text-xs" role="tablist" aria-label="HTML page view">
        {(['preview', 'source'] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={mode === value}
            className={mode === value ? 'rounded border border-nim bg-nim-secondary px-2 py-0.5 text-nim' : 'rounded border border-transparent px-2 py-0.5 text-nim-muted hover:bg-nim-hover'}
            onClick={() => setMode(value)}
          >
            {value === 'preview' ? 'Preview' : 'Source'}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto" hidden={mode !== 'preview'}>
        {html === null ? null : (
          <HtmlEmbedFrame
            html={html}
            shellUrl={WIKI_HTML_EMBED_SHELL_URL}
            onNavigate={(href, options) => navigateFromHtml(null, href, options)}
            theme={theme}
            title={host.fileName}
            className="wiki-web-html-page-frame"
          />
        )}
      </div>
      <div className="relative min-h-0 flex-1" hidden={mode !== 'source'}>
        <div className="absolute inset-0">
          <MonacoEditor host={host} fileName={host.fileName} onEditorReady={onEditorReady} />
        </div>
      </div>
    </div>
  );
}

export const components = { HtmlPageEditor: WikiHtmlPageEditor };
