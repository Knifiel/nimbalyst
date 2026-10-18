/**
 * The `html` page type's editor: the page rendered live through the HTML
 * embed sandbox, with a toggle to its Monaco source.
 *
 * Monaco stays mounted in both modes because it owns the content: it loads
 * and saves through the host locally, and in a shared page it is bound to the
 * page's Y.Text. The preview follows Monaco's model (or the Y.Text directly in
 * a shared page, so a teammate's edit shows without opening the source).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import type { EditorHostProps } from '@nimbalyst/runtime';
import { MonacoEditor, type MonacoEditorCollabConfig } from '@nimbalyst/runtime/editors/MonacoEditor';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { HtmlEmbedFrame, type HtmlEmbedNavigateOptions } from '@nimbalyst/runtime/ui/htmlEmbed/HtmlEmbedFrame';
import { HTML_PAGE_TEXT_FIELD } from '@nimbalyst/runtime/ui/htmlEmbed/htmlPageCodec';

import { htmlLinkBaseFor, openHtmlEmbedLink } from '../EmbedFrame/htmlEmbedNavigation';
import { activeWorkspacePathAtom } from '../../store/atoms/openProjects';
import { DESKTOP_HTML_EMBED_SHELL_URL } from '../EmbedFrame/htmlEmbedShellUrl';
import { useDesktopHtmlEmbedTheme } from '../EmbedFrame/useDesktopHtmlEmbedTheme';

import './HtmlPageEditor.css';

/** Typing in the source reloads the preview this long after the last keystroke. */
const PREVIEW_DEBOUNCE_MS = 400;

const COLLAB_CONFIG: MonacoEditorCollabConfig = { textField: HTML_PAGE_TEXT_FIELD };

type Mode = 'preview' | 'source';

function useDebouncedHtml(): [string | null, (next: string) => void] {
  const [html, setHtml] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const update = useCallback((next: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setHtml(next), PREVIEW_DEBOUNCE_MS);
  }, []);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return [html, (next) => (html === null ? setHtml(next) : update(next))];
}

export function HtmlPageEditor({ host }: EditorHostProps): React.ReactElement {
  const [mode, setMode] = useState<Mode>('preview');
  const [html, setHtml] = useDebouncedHtml();
  const setHtmlRef = useRef(setHtml);
  setHtmlRef.current = setHtml;
  const theme = useDesktopHtmlEmbedTheme();
  const collaboration = host.collaboration;

  // Shared page: the Y.Text is the content.
  useEffect(() => {
    if (!collaboration) return;
    const text = collaboration.yDoc.getText(HTML_PAGE_TEXT_FIELD);
    const read = () => setHtmlRef.current(text.toString());
    read();
    text.observe(read);
    return () => text.unobserve(read);
  }, [collaboration]);

  // Local page or file: the host's content, then the editor's model.
  useEffect(() => {
    if (collaboration) return;
    let cancelled = false;
    host.loadContent().then((content) => {
      if (!cancelled && typeof content === 'string') setHtmlRef.current(content);
    }).catch((error: unknown) => console.error('[HtmlPageEditor] load failed', error));
    const unsubscribe = host.onFileChanged((content) => setHtmlRef.current(content));
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [host, collaboration]);

  const modelListener = useRef<{ dispose(): void } | null>(null);
  const onEditorReady = useCallback((wrapper: { editor?: unknown } | null) => {
    const editor = (wrapper?.editor ?? wrapper) as {
      getValue?: () => string;
      onDidChangeModelContent?: (listener: () => void) => { dispose(): void };
    } | null;
    if (!editor?.onDidChangeModelContent || !editor.getValue) return;
    modelListener.current?.dispose();
    const getValue = editor.getValue.bind(editor);
    modelListener.current = editor.onDidChangeModelContent(() => setHtmlRef.current(getValue()));
  }, []);
  useEffect(() => () => modelListener.current?.dispose(), []);

  // A Team or Personal page resolves relative links in its own page tree.
  const workspacePath = useAtomValue(activeWorkspacePathAtom);
  const onNavigate = useCallback(
    (href: string, options: HtmlEmbedNavigateOptions) => openHtmlEmbedLink(href, options, htmlLinkBaseFor(host.filePath, workspacePath)),
    [host.filePath, workspacePath],
  );

  return (
    <div className={`html-page-editor html-page-editor--${mode}`} data-testid="html-page-editor" data-mode={mode}>
      {host.embedded ? null : (
        <div className="html-page-editor__toolbar" role="tablist" aria-label="HTML page view">
          {(['preview', 'source'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={mode === value}
              className={`html-page-editor__mode${mode === value ? ' html-page-editor__mode--active' : ''}`}
              onClick={() => setMode(value)}
              data-testid={`html-page-editor-${value}`}
            >
              <MaterialSymbol icon={value === 'preview' ? 'visibility' : 'code'} size={16} />
              {value === 'preview' ? 'Preview' : 'Source'}
            </button>
          ))}
        </div>
      )}
      <div className="html-page-editor__preview" hidden={mode !== 'preview'}>
        {html === null ? null : (
          <HtmlEmbedFrame
            html={html}
            shellUrl={DESKTOP_HTML_EMBED_SHELL_URL}
            onNavigate={onNavigate}
            theme={theme}
            title={host.fileName}
          />
        )}
      </div>
      {/* An embed is view only and follows the content through the host. */}
      {host.embedded ? null : (
        <div className="html-page-editor__source" hidden={mode !== 'source'}>
          <MonacoEditor host={host} fileName={host.fileName} collab={COLLAB_CONFIG} onEditorReady={onEditorReady} />
        </div>
      )}
    </div>
  );
}
