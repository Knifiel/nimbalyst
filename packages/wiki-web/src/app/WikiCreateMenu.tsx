/**
 * The sidebar's New control, as the web console's Pages header has it: New
 * page as the main action, the editor page types (drawing, mind map,
 * spreadsheet...) in its menu. The tree builds the menu (`registerCreateMenu`),
 * because the name dialog and destination live there; this only shows it.
 */
import { useState } from 'react';
import { autoUpdate, flip, FloatingPortal, offset, shift, useClick, useDismiss, useFloating, useInteractions, useRole } from '@floating-ui/react';
import type { CollabSidebarCreateMenu } from '@nimbalyst/collab-bundle/docs-ui';
import { MaterialSymbol } from '@nimbalyst/runtime-source/ui/icons/MaterialSymbol';

const CONTROL = 'flex h-[26px] shrink-0 cursor-pointer items-center gap-1 border border-nim bg-transparent px-2 text-[12px] text-nim hover:bg-nim-hover aria-expanded:bg-nim-hover';

export function WikiCreateMenu({ menu }: { menu: CollabSidebarCreateMenu | null }) {
  const [open, setOpen] = useState(false);
  const floating = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'bottom-start',
    whileElementsMounted: autoUpdate,
    middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
  });
  const interactions = useInteractions([useClick(floating.context), useDismiss(floating.context), useRole(floating.context, { role: 'menu' })]);
  if (!menu) return null;
  return (
    <div className="wiki-web-create-menu flex items-center px-2 pt-2">
      <button type="button" className={`${CONTROL} flex-1 rounded-l-md`} onClick={menu.onPrimary} data-testid="wiki-web-new-page">
        <MaterialSymbol icon="add" size={16} />
        New page
      </button>
      {menu.items.length > 0 ? (
        <button
          ref={floating.refs.setReference}
          {...interactions.getReferenceProps()}
          type="button"
          className={`${CONTROL} -ml-px rounded-r-md`}
          aria-label="New page of another kind"
          aria-expanded={open}
          data-testid="wiki-web-new-menu"
        >
          <MaterialSymbol icon="expand_more" size={15} className="text-nim-muted" />
        </button>
      ) : null}
      {open ? (
        <FloatingPortal>
          <div
            ref={floating.refs.setFloating}
            style={floating.floatingStyles}
            {...interactions.getFloatingProps()}
            className="wiki-web-create-menu-list z-[100] min-w-[200px] rounded-[9px] border border-nim bg-nim p-1.5 text-nim shadow-lg"
          >
            {menu.items.map((item) => (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                className="flex w-full cursor-pointer items-center gap-2 rounded-[5px] border-none bg-transparent px-2 py-[6px] text-left text-[12px] text-nim hover:bg-nim-hover"
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
              >
                <MaterialSymbol icon={item.icon || 'description'} size={16} className="text-nim-muted" />
                <span className="flex-1 truncate">{item.label}</span>
              </button>
            ))}
          </div>
        </FloatingPortal>
      ) : null}
    </div>
  );
}
