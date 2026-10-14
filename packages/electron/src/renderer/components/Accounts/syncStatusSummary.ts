/**
 * Collapses a full sync status snapshot into the one line the account popover
 * shows, plus whether the gutter avatar should wear a warning.
 *
 * Sync used to own a gutter slot whose popover reported four counters. The
 * counters were diagnostics nobody acted on, and the slot cost a rail position
 * for every signed-in user even when everything was healthy. What is left is
 * the part a user reacts to: is it on, is it working, when did it last run.
 */

import type { SessionSyncStatus } from '../../../shared/sessionSyncStatus';
import { describePersonalSyncWriteGate } from '@nimbalyst/runtime/sync/personalSyncWriteGate';

export interface SyncStatusSnapshot extends SessionSyncStatus {
  /** Sync is configured at the app level (i.e. the user is signed in). */
  appConfigured: boolean;
  projectEnabled: boolean;
  lastSyncedAt: number | null;
}

export type SyncTone = 'ok' | 'idle' | 'warning' | 'error';

export interface SyncSummary {
  tone: SyncTone;
  /** Right-hand text on the row: "Synced 5m ago", "Off for this project", … */
  detail: string;
  /**
   * True when the user should notice without opening the popover. Drives the
   * avatar warning, which is also what an expired sign-in uses — one
   * "your account needs attention" affordance rather than two.
   */
  needsAttention: boolean;
}

/** Relative age of the last successful sync, or null when it has never run. */
export function formatLastSync(lastSyncedAt: number | null, now: number): string | null {
  if (!lastSyncedAt) return null;
  const diffMs = now - lastSyncedAt;
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMs / 3600000);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffMs / 86400000)}d ago`;
}

export function summarizeSyncStatus(
  status: SyncStatusSnapshot,
  now: number = Date.now(),
): SyncSummary | null {
  // Not signed in: there is nothing to report and no row to draw.
  if (!status.appConfigured) return null;

  // A project the user deliberately opted out of is not a problem to flag.
  if (!status.projectEnabled) {
    return { tone: 'idle', detail: 'Off for this project', needsAttention: false };
  }

  if (status.error) {
    return { tone: 'error', detail: status.error, needsAttention: true };
  }

  const gate = status.personalSyncWriteGate;
  if (gate?.state === 'blocked') {
    return { tone: 'error', detail: describePersonalSyncWriteGate(gate) ?? 'Session sync is paused.', needsAttention: true };
  }
  if (status.connected && gate?.state === 'unverified') {
    return { tone: 'idle', detail: 'Checking session sync…', needsAttention: false };
  }

  if (status.syncing) {
    return { tone: 'ok', detail: 'Syncing…', needsAttention: false };
  }

  if (status.connected) {
    const age = formatLastSync(status.lastSyncedAt, now);
    return { tone: 'ok', detail: age ? `Synced ${age}` : 'Connected', needsAttention: false };
  }

  // Enabled for this project but not connected — the case the old cloud icon
  // existed to make visible, so it has to keep reaching the user somehow.
  return { tone: 'warning', detail: 'Disconnected', needsAttention: true };
}
