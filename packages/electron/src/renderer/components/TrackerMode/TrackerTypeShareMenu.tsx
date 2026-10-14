/**
 * The tracker sidebar's right-click menu on a personal type: "Share with
 * team...", the same promotion Settings > Trackers offers. Only a personal type
 * that can be promoted gets it, and only in a workspace with a team.
 */

import React, { useMemo, useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import type { TrackerDataModel } from '@nimbalyst/tracker-schema';
import { FloatingPortal, useFloatingMenu, virtualElement } from '../../hooks/useFloatingMenu';
import { canShareTrackerTypeWithTeam, shareTrackerTypeWithTeam } from './teamTypeSharing';

export function useTrackerTypeShareMenu(workspacePath: string | null | undefined, hasTeam: boolean) {
  const [target, setTarget] = useState<{ model: TrackerDataModel; x: number; y: number } | null>(null);
  const reference = useMemo(() => virtualElement(target?.x ?? 0, target?.y ?? 0), [target]);
  const menu = useFloatingMenu({
    placement: 'right-start',
    reference,
    open: target !== null,
    onOpenChange: (open) => { if (!open) setTarget(null); },
  });

  /** For a row's `onContextMenu`; undefined leaves the browser's default alone. */
  const onContextMenuFor = (model: TrackerDataModel): React.MouseEventHandler | undefined =>
    hasTeam && workspacePath && canShareTrackerTypeWithTeam(model)
      ? (event) => {
        event.preventDefault();
        setTarget({ model, x: event.clientX, y: event.clientY });
      }
      : undefined;

  const element = target && workspacePath ? (
    <FloatingPortal>
      <div
        ref={menu.refs.setFloating}
        style={menu.floatingStyles}
        {...menu.getFloatingProps()}
        className="tracker-type-share-menu z-[10000] min-w-[170px] p-1 rounded-md border border-nim bg-nim shadow-lg"
      >
        <button
          className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs text-nim-muted hover:bg-nim-tertiary hover:text-nim"
          data-testid="tracker-type-share-with-team"
          onClick={() => {
            const { model } = target;
            setTarget(null);
            void shareTrackerTypeWithTeam(workspacePath, model);
          }}
        >
          <MaterialSymbol icon="group_add" size={14} /> Share with team...
        </button>
      </div>
    </FloatingPortal>
  ) : null;

  return { onContextMenuFor, element };
}
