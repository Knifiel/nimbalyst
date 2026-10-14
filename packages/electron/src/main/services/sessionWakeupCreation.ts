/**
 * Persist a session wakeup, arm the scheduler for it, and tell every window.
 *
 * Shared by the CLI's ScheduleWakeup tool and usage-limit auto-resume. Creating
 * a wakeup cancels any other active one for the same session (store contract).
 */

import { BrowserWindow } from 'electron';
import type { SessionWakeup, SessionWakeupsStore } from './PGLiteSessionWakeupsStore';
import { SessionWakeupScheduler } from './SessionWakeupScheduler';

export interface CreateWakeupRequest {
  sessionId: string;
  /** The project path the session's window is keyed on, not a worktree path. */
  workspacePath: string;
  prompt: string;
  reason: string;
  fireAt: Date;
}

export async function createSessionWakeup(
  store: SessionWakeupsStore,
  request: CreateWakeupRequest,
): Promise<SessionWakeup> {
  const row = await store.create({
    id: `wakeup-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    sessionId: request.sessionId,
    workspaceId: request.workspacePath,
    prompt: request.prompt,
    reason: request.reason,
    fireAt: request.fireAt,
  });
  SessionWakeupScheduler.getInstance().onCreated(row);

  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    try {
      window.webContents.send('wakeup:changed', row);
    } catch {
      // ignore -- window destroyed mid-send
    }
  }
  return row;
}
