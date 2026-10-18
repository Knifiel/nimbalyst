/**
 * An `.html` page embedded in a markdown page: live and interactive without
 * selecting it first, following the file as it changes on disk. Its links
 * resolve beside the HTML page itself, as when it is opened on its own.
 */
import { useEffect, useState } from 'react';
import { HtmlEmbedFrame } from '@nimbalyst/runtime-source/ui/htmlEmbed/HtmlEmbedFrame';
import { wikiApi, wikiChanges } from '../../api/client';
import { navigateFromHtml, useWikiHtmlEmbedTheme, WIKI_HTML_EMBED_SHELL_URL } from './htmlPages';

export function useWikiPageText(pageId: string): string | null {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => {
      wikiApi.readBody(pageId).then((body) => {
        if (live) setText(body.markdown);
      }).catch(() => {});
    };
    load();
    const unsubscribe = wikiChanges.subscribe((event) => {
      if (event.type === 'ready' || (event.type === 'change' && event.change.changedIds.includes(pageId))) load();
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [pageId]);
  return text;
}

export function WikiHtmlEmbed({ pageId, title, height }: { pageId: string; title: string; height?: number }) {
  const html = useWikiPageText(pageId);
  const theme = useWikiHtmlEmbedTheme();
  if (html === null) return <div className="p-4 text-xs text-nim-faint">Loading {title}…</div>;
  return (
    <HtmlEmbedFrame
      html={html}
      shellUrl={WIKI_HTML_EMBED_SHELL_URL}
      onNavigate={(href, options) => navigateFromHtml(pageId, href, options)}
      theme={theme}
      height={height}
      title={title}
    />
  );
}
