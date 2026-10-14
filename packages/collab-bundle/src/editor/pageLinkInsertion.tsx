/**
 * The `@` page-link picker for hosts whose pages are files linked by relative
 * path (the local wiki browser view). It inserts an ordinary markdown link,
 * `[Title](rel/path.md "id=...")`, so the file reads correctly outside
 * Nimbalyst; it never writes a `nimbalyst://doc/` reference.
 *
 * Desktop pages use the runtime DocumentLinkPlugin over its document service;
 * this host has neither, so it takes the page list from the mount option
 * `pageLinks`. Enabled per mount: without that option this renders nothing.
 */

import React from 'react';
import { $createLinkNode, $isLinkNode } from '@lexical/link';
import { $createTextNode, $getNodeByKey, $getSelection, $isRangeSelection, type LexicalEditor, type TextNode } from 'lexical';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';

import { registerExtensionEditorComponent } from '@nimbalyst/runtime/editor/extensions/extensionEditorComponentsStore';
import { TypeaheadMenuPlugin } from '@nimbalyst/runtime/editor/plugins/TypeaheadPlugin/TypeaheadMenuPlugin';
import type { TypeaheadMenuOption } from '@nimbalyst/runtime/editor/plugins/TypeaheadPlugin/TypeaheadMenu';
import { fuzzyFilterDocuments } from '@nimbalyst/runtime/utils/fuzzyMatch';

import type { PageLinkOption, PageLinkSource } from './types';

const SOURCE = 'browser-page-link-insertion';
const CREATE_ID = '__create-page__';
const NO_MATCHES_ID = '__no-page-matches__';

export const BrowserPageLinkContext = React.createContext<PageLinkSource | null>(null);

/**
 * `@` followed by a run of non-space text, at the start of a line or after
 * whitespace or `(`. A space ends it, as on desktop: `@q3` finds "Q3 Plan".
 */
export function matchPageLinkTrigger(text: string): { leadOffset: number; matchingString: string; replaceableString: string } | null {
  const match = /(^|\s|\()(@([^@\s()[\]"'<>]{0,75}))$/.exec(text);
  if (!match) return null;
  return { leadOffset: match.index + match[1].length, matchingString: match[3], replaceableString: match[2] };
}

/** The options for a query: fuzzy-ranked pages, then "Create page" when nothing has that exact title. */
export function pageLinkMenu(pages: readonly PageLinkOption[], query: string, canCreate: boolean): Array<{ id: string; label: string; secondaryText?: string; icon?: string; disabled?: boolean }> {
  const ranked = fuzzyFilterDocuments(pages.map((page) => ({ ...page, name: page.title, path: page.folderPath ?? '' })), query, 50);
  const rows: Array<{ id: string; label: string; secondaryText?: string; icon?: string; disabled?: boolean }> = ranked.map(({ item }) => ({
    id: item.id,
    label: item.title,
    secondaryText: item.folderPath || undefined,
    icon: item.icon ?? 'description',
  }));
  const title = query.trim();
  if (canCreate && title && !pages.some((page) => page.title.toLowerCase() === title.toLowerCase())) {
    rows.push({ id: CREATE_ID, label: `Create page “${title}”`, icon: 'note_add' });
  }
  if (rows.length === 0) rows.push({ id: NO_MATCHES_ID, label: title ? `No pages match “${title}”` : 'No other pages yet', disabled: true });
  return rows;
}

function $insertPageLink(option: PageLinkOption): string | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return null;
  const link = $createLinkNode(option.href, option.linkTitle ? { title: option.linkTitle } : undefined);
  link.append($createTextNode(option.title));
  selection.insertNodes([link]);
  const space = $createTextNode(' ');
  link.insertAfter(space);
  space.select();
  return link.getKey();
}

/** Points a placeholder link at the page once it exists, or turns it back into text when creating failed. */
function completeCreatedLink(editor: LexicalEditor, key: string, created: PageLinkOption | null): void {
  editor.update(() => {
    const node = $getNodeByKey(key);
    if (!$isLinkNode(node)) return;
    if (created) {
      node.setURL(created.href);
      node.setTitle(created.linkTitle ?? null);
    } else {
      for (const child of node.getChildren()) node.insertBefore(child);
      node.remove();
    }
  });
}

function PageLinkTypeahead({ source }: { source: PageLinkSource }): React.JSX.Element {
  const [editor] = useLexicalComposerContext();
  const [query, setQuery] = React.useState('');
  const [pages, setPages] = React.useState<readonly PageLinkOption[]>([]);

  const rows = pageLinkMenu(pages, query, Boolean(source.createPage));
  const options: TypeaheadMenuOption[] = rows.map((row) => ({
    id: row.id,
    label: row.label,
    secondaryText: row.secondaryText,
    icon: row.icon ? <span className="material-symbols-outlined" style={{ fontSize: 16 }}>{row.icon}</span> : undefined,
    disabled: row.disabled,
    onSelect: () => {}, // handled in onSelectOption
  }));

  const onSelectOption = React.useCallback((option: TypeaheadMenuOption, _node: TextNode | null, closeMenu: () => void) => {
    closeMenu();
    if (option.disabled) return;
    if (option.id === CREATE_ID && source.createPage) {
      const title = query.trim();
      let key: string | null = null;
      // The link goes in now, so typing on does not move where it lands; its target follows.
      editor.update(() => {
        key = $insertPageLink({ id: '', title, href: '' });
      });
      void source.createPage(title).then(
        (created) => key && completeCreatedLink(editor, key, created),
        (error: unknown) => {
          if (key) completeCreatedLink(editor, key, null);
          source.onError?.(error);
        },
      );
      return;
    }
    const page = pages.find((candidate) => candidate.id === option.id);
    if (page) editor.update(() => void $insertPageLink(page));
  }, [editor, pages, query, source]);

  return (
    <TypeaheadMenuPlugin
      options={options}
      triggerFn={matchPageLinkTrigger}
      onQueryChange={(next) => setQuery(next ?? '')}
      onSelectOption={onSelectOption}
      // Read when the menu opens, so the editor never re-renders as pages change.
      onOpen={() => setPages(source.list())}
      minWidth={320}
      maxWidth={480}
      maxHeight={360}
    />
  );
}

export function BrowserPageLinkInsertion(): React.JSX.Element | null {
  const source = React.useContext(BrowserPageLinkContext);
  return source ? <PageLinkTypeahead source={source} /> : null;
}

let registered = false;

/** Publish the picker into the editor's component slot. Idempotent; see `./referenceNodes` for why it is a call. */
export function registerBrowserPageLinkInsertion(): void {
  if (registered) return;
  registered = true;
  registerExtensionEditorComponent({ name: SOURCE, Component: BrowserPageLinkInsertion });
}
