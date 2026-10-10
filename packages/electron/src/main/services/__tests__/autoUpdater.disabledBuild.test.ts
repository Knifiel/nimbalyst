// @vitest-environment node
/**
 * A package built with NIMBALYST_DISABLE_AUTO_UPDATE=1 (a fork or a local build)
 * must never take an official release: autoDownload plus install-on-quit would
 * silently replace it with upstream on the next quit.
 */
import { expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  process.env.NIMBALYST_DISABLE_AUTO_UPDATE = '1';
  return {
    handlers: new Map<string, (...args: unknown[]) => unknown>(),
    send: vi.fn(),
    updater: {
      autoDownload: true,
      autoInstallOnAppQuit: true,
      on: vi.fn(),
      setFeedURL: vi.fn(),
      checkForUpdates: vi.fn(),
      checkForUpdatesAndNotify: vi.fn(),
      downloadUpdate: vi.fn(),
    } as Record<string, any>,
  };
});

vi.mock('electron-updater', () => ({ autoUpdater: mocks.updater }));
vi.mock('electron', () => {
  const win = { isDestroyed: () => false, webContents: { getURL: () => 'app://index.html', send: mocks.send } };
  return {
    app: { isPackaged: true },
    BrowserWindow: { getFocusedWindow: () => win, getAllWindows: () => [win] },
    dialog: {},
  };
});
vi.mock('electron-log/main', () => ({ default: { transports: { file: {} }, info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../utils/store', () => ({ getReleaseChannel: () => 'stable', store: {} }));
vi.mock('../../utils/ipcRegistry', () => ({
  safeHandle: (name: string, fn: (...args: unknown[]) => unknown) => mocks.handlers.set(name, fn),
  safeOn: vi.fn(),
}));
vi.mock('../analytics/AnalyticsService', () => ({ AnalyticsService: {} }));
vi.mock('../../ipc/SessionStateHandlers', () => ({ hasActiveStreamingSessions: vi.fn() }));
vi.mock('@nimbalyst/runtime/ai/server/SessionStateManager', () => ({ getSessionStateManager: vi.fn() }));
vi.mock('../../database/initialize', () => ({ getDatabase: vi.fn() }));
vi.mock('../electronUpdaterPatch', () => ({ installAtomFeedFilter: vi.fn() }));

import { autoUpdaterService } from '../autoUpdater';

it('never checks, downloads or installs, and says so when asked to check', async () => {
  vi.useFakeTimers();
  try {
    expect(mocks.updater.autoDownload).toBe(false);
    expect(mocks.updater.autoInstallOnAppQuit).toBe(false);

    autoUpdaterService.startAutoUpdateCheck(60);
    await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);
    await autoUpdaterService.checkForUpdates();
    await autoUpdaterService.checkForUpdatesWithUI();
    expect(await mocks.handlers.get('check-for-updates')!()).toBeNull();
    expect(await mocks.handlers.get('download-update')!()).toEqual({ success: false });

    expect(mocks.updater.checkForUpdates).not.toHaveBeenCalled();
    expect(mocks.updater.checkForUpdatesAndNotify).not.toHaveBeenCalled();
    expect(mocks.updater.downloadUpdate).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenCalledWith('update-toast:error', { message: 'Updates are turned off in this build' });
  } finally {
    vi.useRealTimers();
  }
});
