// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import { activeWorkspacePathAtom } from '../openProjects';
import {
  clearNavigationHistory, currentNavigationEntryAtom, goBackAtom, goForwardAtom,
  initNavigationHistory, pushNavigationEntryAtom, registerNavigationRestoreCallbacks,
} from '../navigationHistory';

vi.mock('../openProjects', async () => {
  const { atom } = await import('jotai');
  return { activeWorkspacePathAtom: atom<string | null>(null) };
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 0));
  vi.stubGlobal('window', {});
  store.set(activeWorkspacePathAtom, '/projects/LibraryKit');
  clearNavigationHistory();
});
afterEach(() => {
  vi.runAllTimers();
  registerNavigationRestoreCallbacks({ restoreSettings: undefined });
  clearNavigationHistory();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('keeps separate history entries for the same settings page in different projects', () => {
  const restoreSettings = vi.fn();
  registerNavigationRestoreCallbacks({ restoreSettings });
  const settings = (workspacePath: string) => ({
    category: 'project-appearance', scope: 'project' as const,
    target: { kind: 'workspace' as const, workspacePath },
  });
  const fileRocket = settings('/projects/FileRocket');
  const libraryKit = settings('/projects/LibraryKit');
  store.set(pushNavigationEntryAtom, { mode: 'settings', settings: fileRocket });
  store.set(pushNavigationEntryAtom, { mode: 'settings', settings: libraryKit });
  // A repeated render of the same destination must not create a third entry.
  store.set(pushNavigationEntryAtom, { mode: 'settings', settings: settings('/projects/LibraryKit') });
  expect(store.get(currentNavigationEntryAtom)?.settings).toEqual(libraryKit);
  store.set(goBackAtom);
  expect(restoreSettings).toHaveBeenLastCalledWith(fileRocket);
  vi.runAllTimers();
  store.set(goForwardAtom);
  expect(restoreSettings).toHaveBeenLastCalledWith(libraryKit);
});

it('gives saved project settings entries without a target to their own project, so Back keeps Forward', async () => {
  const workspacePath = '/projects/Upgraded';
  const general = { category: 'general', scope: 'application' as const };
  vi.stubGlobal('window', { electronAPI: { invoke: vi.fn(async () => ({ navigationHistory: { currentIndex: 1, entries: [
    // Saved before project settings entries carried a target.
    { mode: 'settings', settings: { category: 'project-appearance', scope: 'project' }, timestamp: 1 },
    { mode: 'settings', settings: general, timestamp: 2 },
  ] } })) } });
  const restoreSettings = vi.fn();
  registerNavigationRestoreCallbacks({ restoreSettings });
  await initNavigationHistory(workspacePath);
  const appearance = { category: 'project-appearance', scope: 'project' as const, target: { kind: 'workspace' as const, workspacePath } };
  store.set(goBackAtom);
  expect(restoreSettings).toHaveBeenLastCalledWith(appearance);
  vi.runAllTimers();
  // SettingsView records the restored page once restoring ends; it must not count as new navigation.
  store.set(pushNavigationEntryAtom, { mode: 'settings', settings: appearance });
  store.set(goForwardAtom);
  expect(restoreSettings).toHaveBeenLastCalledWith(general);
});
