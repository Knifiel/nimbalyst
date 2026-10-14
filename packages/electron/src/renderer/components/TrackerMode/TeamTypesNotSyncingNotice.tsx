/**
 * One muted line where team types are listed, shown when this workspace has
 * team types but its tracker sync is not connected -- otherwise they look
 * shared while nothing reaches the team. See `useTeamTypesNotSyncing`.
 */

import React from 'react';
import { TEAM_TYPES_NOT_SYNCING_MESSAGE, useTeamTypesNotSyncing } from './teamTypeSharing';

export function TeamTypesNotSyncingNotice({ workspacePath }: { workspacePath: string | null | undefined }) {
  if (!useTeamTypesNotSyncing(workspacePath)) return null;
  return (
    <div className="team-types-not-syncing px-2 py-1 text-[11px] text-nim-faint" role="status" data-testid="team-types-not-syncing">
      {TEAM_TYPES_NOT_SYNCING_MESSAGE}
    </div>
  );
}
