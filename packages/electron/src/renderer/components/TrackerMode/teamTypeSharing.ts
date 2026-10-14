/**
 * Two things a person needs when a type they expected the team to see is not
 * there: a way to share a personal type (the same promotion Settings > Trackers
 * runs, with the same confirmation), and a word when the workspace's team types
 * are not reaching the team's server at all.
 *
 * Personal types stay on this machine by design; nothing here changes that
 * default. It only makes the state visible and the existing promotion closer.
 */

import { useEffect, useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import { store } from '@nimbalyst/runtime/store';
import { globalRegistry, type TrackerDataModel } from '@nimbalyst/tracker-schema';
import { trackerItemCountByTypeAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin';
import {
  describeTrackerPromotion,
  resolveTrackerPromotionEligibility,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models/trackerLifecycle';
import { requestConfirmation } from '../../dialogs/requestConfirmation';
import { errorNotificationService } from '../../services/ErrorNotificationService';
import { trackerSyncConnectionAtom } from '../../store/atoms/trackerSync';
import { TEAM_TYPES_NOT_SYNCING_GRACE_MS, teamTypesAreNotSyncing } from './teamTypesSyncState';

export { TEAM_TYPES_NOT_SYNCING_MESSAGE } from './teamTypesSyncState';

export function canShareTrackerTypeWithTeam(model: TrackerDataModel): boolean {
  return model.sharing === 'personal' && resolveTrackerPromotionEligibility(model).canPromote;
}

/** Confirm, then promote a personal type and its items to the team. Resolves true once it is the team's. */
export async function shareTrackerTypeWithTeam(workspacePath: string, model: TrackerDataModel): Promise<boolean> {
  const copy = describeTrackerPromotion(model, store.get(trackerItemCountByTypeAtom(model.type)));
  const approved = await requestConfirmation({
    title: copy.title,
    message: copy.message,
    confirmLabel: copy.confirmLabel,
    cancelLabel: 'Cancel',
    destructive: false,
  });
  if (!approved) return false;
  try {
    const result = await window.electronAPI.trackerLifecycle.promoteToTeam({ workspacePath, type: model.type });
    if (!result?.success) throw new Error(result?.error || 'Could not share this tracker with your team.');
    const { publishedCount = 0, pendingKeyCount = 0 } = result.promotion ?? {};
    errorNotificationService.showInfo(
      `${model.displayNamePlural} is now your team's`,
      pendingKeyCount > 0
        ? `${publishedCount} item(s) published. ${pendingKeyCount} are waiting on the server for their keys.`
        : `${publishedCount} item(s) published, each with its issue key.`,
      { duration: 4000 },
    );
    return true;
  } catch (error) {
    errorNotificationService.showError('Tracker update failed', error instanceof Error ? error.message : String(error));
    return false;
  }
}

/** {@link teamTypesAreNotSyncing} for the current registry, held back for the grace period. */
export function useTeamTypesNotSyncing(workspacePath: string | null | undefined): boolean {
  const connection = useAtomValue(trackerSyncConnectionAtom);
  const [registryRevision, setRegistryRevision] = useState(0);
  useEffect(() => globalRegistry.onChange(() => setRegistryRevision((value) => value + 1)), []);
  // registryRevision invalidates the memo when types change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const hasTeamTypes = useMemo(() => globalRegistry.getListed().some((type) => type.sharing === 'team'), [registryRevision]);
  const notSyncing = teamTypesAreNotSyncing(connection, workspacePath, hasTeamTypes);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!notSyncing) {
      setShown(false);
      return;
    }
    const timer = setTimeout(() => setShown(true), TEAM_TYPES_NOT_SYNCING_GRACE_MS);
    return () => clearTimeout(timer);
  }, [notSyncing]);
  return shown;
}
