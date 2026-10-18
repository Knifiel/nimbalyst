/**
 * A workspace `.html` file embedded in a page, rendered live through the HTML
 * embed sandbox (`HtmlEmbedFrame`) instead of the Browser extension's native
 * overlay, which neither scrolls with the document nor sits under popovers.
 *
 * Interactive without selecting first: there is no click-to-select shield,
 * so a reader clicks straight into the diagram. Selection (for delete and
 * keyboard handling) comes from a small handle shown on hover, and the size
 * from the shared bottom-right grip placed views use. The content follows
 * the file on disk and the frame follows the app theme live.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useAtomValue } from 'jotai';
import { basename } from 'pathe';
import { useLexicalNodeSelection } from '@lexical/react/useLexicalNodeSelection';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { useDocumentPath } from '@nimbalyst/runtime/DocumentPathContext';
import type { EmbedFrameProps } from '@nimbalyst/runtime/editor/plugins/EmbedPlugin/EmbedPluginCallbacks';
import { usePlacedViewAttrs } from '@nimbalyst/runtime/editor/plugins/EmbedPlugin/usePlacedViewAttrs';
import {
  PlacedViewResizeFrame,
  MIN_PLACED_VIEW_BODY_HEIGHT,
} from '@nimbalyst/runtime/editor/plugins/EmbedPlugin/PlacedViewResizeFrame';
import { HtmlEmbedFrame, type HtmlEmbedNavigateOptions } from '@nimbalyst/runtime/ui/htmlEmbed/HtmlEmbedFrame';

import { DiskChangeSubscription } from '../../services/document-model/DiskChangeSubscription';
import { activeWorkspacePathAtom } from '../../store/atoms/openProjects';
import { useEmbedFilePath } from './useEmbedFilePath';
import { openFileInTab, readFileFromDisk, workspaceRelativePath } from './embeddedFileIo';
import { htmlLinkBaseFor, openHtmlEmbedLink } from './htmlEmbedNavigation';
import { DESKTOP_HTML_EMBED_SHELL_URL } from './htmlEmbedShellUrl';
import { useDesktopHtmlEmbedTheme } from './useDesktopHtmlEmbedTheme';

import './HtmlFileEmbedFrame.css';

/**
 * The file's text, following it on disk. `DiskChangeSubscription` registers
 * the file with main as open, which is what makes the watcher report changes
 * to a gitignored file too.
 */
function useFileText(absolutePath: string | null): { text: string | null; error: string | null } {
  const [state, setState] = useState<{ text: string | null; error: string | null }>({ text: null, error: null });
  useEffect(() => {
    if (!absolutePath) return;
    let cancelled = false;
    const show = (text: string) => {
      if (!cancelled) setState((previous) => (previous.text === text && !previous.error ? previous : { text, error: null }));
    };
    readFileFromDisk(absolutePath).then(show).catch((error: unknown) => {
      if (!cancelled) setState({ text: null, error: error instanceof Error ? error.message : String(error) });
    });
    const subscription = new DiskChangeSubscription(
      absolutePath,
      () => readFileFromDisk(absolutePath),
      ({ content }) => show(typeof content === 'string' ? content : new TextDecoder().decode(content)),
      () => {
        if (!cancelled) setState({ text: null, error: 'The file was deleted' });
      },
    );
    return () => {
      cancelled = true;
      subscription.dispose();
    };
  }, [absolutePath]);
  return state;
}

export function parseHtmlEmbedHeight(value: string | undefined): number | undefined {
  const parsed = value ? parseInt(value, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(parsed, MIN_PLACED_VIEW_BODY_HEIGHT) : undefined;
}

export const HtmlFileEmbedFrame: React.FC<EmbedFrameProps> = ({ src, label, attrs, nodeKey, detached = false }) => {
  const { documentDir } = useDocumentPath();
  const workspacePath = useAtomValue(activeWorkspacePathAtom);
  const { path: absolutePath, pending, error: pathError } = useEmbedFilePath(src, documentDir, workspacePath);
  const { text, error: readError } = useFileText(absolutePath);
  const theme = useDesktopHtmlEmbedTheme();
  const onAttrsChange = usePlacedViewAttrs(nodeKey, detached);
  const [isSelected, setSelected, clearSelection] = useLexicalNodeSelection(nodeKey);
  const height = parseHtmlEmbedHeight(attrs.height);

  // Links resolve beside the HTML file itself, as when it is opened on its own.
  const onNavigate = useCallback(
    (href: string, options: HtmlEmbedNavigateOptions) => openHtmlEmbedLink(href, options, htmlLinkBaseFor(absolutePath, workspacePath)),
    [absolutePath, workspacePath],
  );

  const select = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      clearSelection();
      setSelected(true);
    },
    [clearSelection, setSelected],
  );

  const open = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (absolutePath) openFileInTab(absolutePath);
    },
    [absolutePath, workspacePath],
  );

  const problem = pending ? null : pathError || (!absolutePath ? 'Could not resolve embed path' : readError);
  const name = absolutePath ? basename(absolutePath) : src;

  return (
    <PlacedViewResizeFrame attrs={attrs} onAttrsChange={onAttrsChange}>
      <div
        className={`html-file-embed${isSelected ? ' html-file-embed--selected' : ''}`}
        data-testid="html-file-embed"
        data-embed-selected={isSelected ? 'true' : 'false'}
        title={label || undefined}
      >
        <div className="html-file-embed__handles" contentEditable={false}>
          <button
            type="button"
            className="html-file-embed__handle"
            onMouseDown={select}
            aria-label={`Select ${name}`}
            title="Select"
            data-testid="html-file-embed-select"
          >
            <MaterialSymbol icon="drag_indicator" size={16} />
          </button>
          {absolutePath ? (
            <button
              type="button"
              className="html-file-embed__handle"
              onMouseDown={open}
              aria-label={`Open ${name}`}
              title={absolutePath ? `Open ${workspaceRelativePath(absolutePath)}` : undefined}
            >
              <MaterialSymbol icon="open_in_new" size={16} />
            </button>
          ) : null}
        </div>
        <div
          className={`html-file-embed__body${height ? ' html-file-embed__body--sized' : ''}`}
          data-placed-view-body=""
          style={height ? { height } : undefined}
        >
          {problem ? (
            <div className="html-file-embed__placeholder" data-testid="html-file-embed-error">
              <MaterialSymbol icon="link_off" size={24} />
              <span>{problem}</span>
              <code>{src}</code>
            </div>
          ) : text === null ? (
            <div className="html-file-embed__placeholder">Loading {name}…</div>
          ) : (
            <HtmlEmbedFrame
              html={text}
              shellUrl={DESKTOP_HTML_EMBED_SHELL_URL}
              onNavigate={onNavigate}
              theme={theme}
              height={height}
              title={label || name}
            />
          )}
        </div>
      </div>
    </PlacedViewResizeFrame>
  );
};
