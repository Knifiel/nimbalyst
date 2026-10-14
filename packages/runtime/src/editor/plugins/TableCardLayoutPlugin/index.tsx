/**
 * Decorates table DOM so narrow containers can render body rows as cards.
 *
 * Every body cell gets `data-label` = its column's header text, and a table
 * whose first row is a header row gets `data-nim-table-cards`. The table that
 * currently holds the selection gets `data-nim-table-editing`, which turns card
 * layout off for it: editing always happens in the normal grid, so Lexical's
 * cell selection, resizing and action menus never see the card layout. The CSS
 * that consumes these attributes lives in NimbalystEditorTheme.css and only
 * applies inside a narrow `.nim-table-scrollable-wrapper` container.
 *
 * Only DOM attributes are written; the document and its markdown are untouched.
 */

import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $findTableNode,
  $isTableCellNode,
  $isTableRowNode,
  $isTableSelection,
  getTableElement,
  TableCellHeaderStates,
  TableNode,
} from '@lexical/table';
import { mergeRegister } from '@lexical/utils';
import {
  $getNodeByKey,
  $getSelection,
  $isRangeSelection,
  type LexicalEditor,
  type NodeKey,
} from 'lexical';
import { useEffect } from 'react';

export const TABLE_CARDS_ATTR = 'data-nim-table-cards';
export const TABLE_EDITING_ATTR = 'data-nim-table-editing';
export const CELL_LABEL_ATTR = 'data-label';

/**
 * True when the card CSS is currently applied to this table. Whether it applies
 * depends on the container width, which only layout knows, so read the
 * computed display (a table in grid mode is `table`, in card mode `block`).
 */
export function isTableShowingCards(tableDOM: HTMLElement): boolean {
  return (
    tableDOM.hasAttribute(TABLE_CARDS_ATTR) &&
    !tableDOM.hasAttribute(TABLE_EDITING_ATTR) &&
    getComputedStyle(tableDOM).display === 'block'
  );
}

function getTableDOM(editor: LexicalEditor, table: TableNode): HTMLElement | null {
  const dom = editor.getElementByKey(table.getKey());
  return dom ? getTableElement(table, dom) : null;
}

function $syncTableLabels(editor: LexicalEditor, table: TableNode): void {
  const tableDOM = getTableDOM(editor, table);
  if (!tableDOM) return;

  const rows = table.getChildren().filter($isTableRowNode);
  const headerCells = (rows[0]?.getChildren() ?? []).filter($isTableCellNode);
  const hasHeaderRow =
    rows.length > 1 &&
    headerCells.length > 0 &&
    headerCells.every((cell) => cell.hasHeaderState(TableCellHeaderStates.ROW));
  tableDOM.toggleAttribute(TABLE_CARDS_ATTR, hasHeaderRow);

  const labels: string[] = [];
  if (hasHeaderRow) {
    for (const cell of headerCells) {
      const text = cell.getTextContent().trim();
      for (let span = 0; span < cell.getColSpan(); span++) labels.push(text);
    }
  }

  for (const row of rows.slice(1)) {
    let column = 0;
    for (const cell of row.getChildren().filter($isTableCellNode)) {
      const cellDOM = editor.getElementByKey(cell.getKey());
      const label = labels[column];
      if (cellDOM) {
        if (label) cellDOM.setAttribute(CELL_LABEL_ATTR, label);
        else cellDOM.removeAttribute(CELL_LABEL_ATTR);
      }
      column += cell.getColSpan();
    }
  }
}

function $getEditingTableKey(editor: LexicalEditor): NodeKey | null {
  if (!editor.isEditable()) return null;
  const selection = $getSelection();
  if ($isTableSelection(selection)) return selection.tableKey;
  if ($isRangeSelection(selection)) {
    return $findTableNode(selection.anchor.getNode())?.getKey() ?? null;
  }
  return null;
}

export function registerTableCardLayout(editor: LexicalEditor): () => void {
  let editingKey: NodeKey | null = null;

  const syncEditing = () => {
    editor.getEditorState().read(() => {
      const nextKey = $getEditingTableKey(editor);
      if (editingKey && editingKey !== nextKey) {
        const prev = $getNodeByKey(editingKey);
        if (prev instanceof TableNode) {
          getTableDOM(editor, prev)?.removeAttribute(TABLE_EDITING_ATTR);
        }
      }
      if (nextKey) {
        const next = $getNodeByKey(nextKey);
        if (next instanceof TableNode) {
          getTableDOM(editor, next)?.setAttribute(TABLE_EDITING_ATTR, '');
        }
      }
      editingKey = nextKey;
    });
  };

  return mergeRegister(
    // Covers tables present at registration and every table created later.
    editor.registerMutationListener(
      TableNode,
      (mutations) => {
        editor.getEditorState().read(() => {
          for (const [key, mutation] of mutations) {
            if (mutation === 'destroyed') continue;
            const table = $getNodeByKey(key);
            if (table instanceof TableNode) $syncTableLabels(editor, table);
          }
        });
      },
      { skipInitialization: false }
    ),
    // A header edit dirties its table ancestor, so dirty tables are resynced.
    editor.registerUpdateListener(({ dirtyElements, editorState }) => {
      if (dirtyElements.size > 0) {
        editorState.read(() => {
          for (const key of dirtyElements.keys()) {
            const node = $getNodeByKey(key);
            if (node instanceof TableNode) $syncTableLabels(editor, node);
          }
        });
      }
      syncEditing();
    }),
    editor.registerEditableListener(syncEditing)
  );
}

export default function TableCardLayoutPlugin(): null {
  const [editor] = useLexicalComposerContext();
  useEffect(() => registerTableCardLayout(editor), [editor]);
  return null;
}
