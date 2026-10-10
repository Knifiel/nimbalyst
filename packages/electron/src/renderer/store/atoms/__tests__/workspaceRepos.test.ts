// @vitest-environment node
/**
 * Repo attribution in the renderer. Everything downstream -- the title-bar
 * branch indicator, the Git panel's repo picker, grouped change lists -- keys
 * off these two answers, and the hard requirement is the negative one: a
 * single-repo workspace must resolve exactly as it did before multi-root.
 */
import { describe, expect, it } from 'vitest';
import { createStore } from 'jotai';
import {
  groupPathsByRepo,
  repoLabels,
  resolveRepoForPath,
} from '../../../utils/workspaceRepos';
import { activeFileRepoPathAtom, workspaceRepoPathsAtom } from '../workspaceRepos';
import { bindActiveFileToTabs } from '../fileTree';

const REPOS = ['/proj', '/other/collab'];

describe('resolveRepoForPath', () => {
  it('attributes a file to the repo containing it', () => {
    expect(resolveRepoForPath(REPOS, '/proj/src/index.ts')).toBe('/proj');
    expect(resolveRepoForPath(REPOS, '/other/collab/src/index.ts')).toBe('/other/collab');
  });

  it('returns null for a file in no repo, rather than guessing the first', () => {
    expect(resolveRepoForPath(REPOS, '/elsewhere/a.ts')).toBeNull();
    expect(resolveRepoForPath([], '/proj/a.ts')).toBeNull();
  });

  it('prefers the deepest repo when one is checked out inside another', () => {
    expect(resolveRepoForPath(['/proj', '/proj/vendor/lib'], '/proj/vendor/lib/a.ts'))
      .toBe('/proj/vendor/lib');
  });

  it('does not match a sibling that shares a path prefix', () => {
    expect(resolveRepoForPath(['/proj'], '/proj2/a.ts')).toBeNull();
  });
});

describe('repoLabels', () => {
  it('uses bare folder names when they are unambiguous', () => {
    expect(repoLabels(REPOS)).toEqual({ '/proj': 'proj', '/other/collab': 'collab' });
  });

  it('disambiguates only the colliding entries with a parent segment', () => {
    expect(repoLabels(['/app/api', '/infra/api', '/proj'])).toEqual({
      '/app/api': 'app/api',
      '/infra/api': 'infra/api',
      '/proj': 'proj',
    });
  });
});

describe('groupPathsByRepo', () => {
  it('returns one group when every path is in one repo, so callers skip headers', () => {
    const groups = groupPathsByRepo(REPOS, ['/proj/a.ts', '/proj/b.ts']);
    expect(groups).toEqual([{ repoPath: '/proj', files: ['/proj/a.ts', '/proj/b.ts'] }]);
  });

  it('orders groups by repo and puts files in no repo last', () => {
    const groups = groupPathsByRepo(REPOS, [
      '/elsewhere/x.ts',
      '/other/collab/b.ts',
      '/proj/a.ts',
    ]);
    expect(groups).toEqual([
      { repoPath: '/proj', files: ['/proj/a.ts'] },
      { repoPath: '/other/collab', files: ['/other/collab/b.ts'] },
      { repoPath: null, files: ['/elsewhere/x.ts'] },
    ]);
  });
});

describe('activeFileRepoPathAtom', () => {
  // A stand-in for TabsContext, where the main editor's tabs live. The atom
  // used to read a Jotai tab atom nothing wrote, so it always answered the
  // first repo; these drive the binding EditorMode installs instead.
  function mainTabs(store: ReturnType<typeof createStore>) {
    let snapshot = { activeTabId: null as string | null, tabs: new Map<string, { filePath: string }>() };
    const listeners = new Set<() => void>();
    const unbind = bindActiveFileToTabs({
      subscribe: (callback) => {
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
      getSnapshot: () => snapshot,
    }, store);
    return {
      open(filePath: string) {
        snapshot = { activeTabId: filePath, tabs: new Map([...snapshot.tabs, [filePath, { filePath }]]) };
        listeners.forEach((callback) => callback());
      },
      unbind,
    };
  }

  it('follows the repo of the file the main editor shows', () => {
    const store = createStore();
    store.set(workspaceRepoPathsAtom, REPOS);
    const tabs = mainTabs(store);

    tabs.open('/other/collab/src/index.ts');
    expect(store.get(activeFileRepoPathAtom)).toBe('/other/collab');
    tabs.open('/proj/src/index.ts');
    expect(store.get(activeFileRepoPathAtom)).toBe('/proj');
  });

  it('falls back to the first repo for a file in none or a tab that is not a file', () => {
    const store = createStore();
    store.set(workspaceRepoPathsAtom, REPOS);
    const tabs = mainTabs(store);

    tabs.open('/elsewhere/a.ts');
    expect(store.get(activeFileRepoPathAtom)).toBe('/proj');
    tabs.open('/other/collab/a.ts');
    tabs.open('tracker://item-1');
    expect(store.get(activeFileRepoPathAtom)).toBe('/proj');
  });

  it('keeps the last file after the main editor unmounts, for agent mode', () => {
    const store = createStore();
    store.set(workspaceRepoPathsAtom, REPOS);
    const tabs = mainTabs(store);

    tabs.open('/other/collab/a.ts');
    tabs.unbind();
    tabs.open('/proj/a.ts');
    expect(store.get(activeFileRepoPathAtom)).toBe('/other/collab');
  });

  it('is null when the workspace contains no repo at all', () => {
    const store = createStore();
    store.set(workspaceRepoPathsAtom, []);

    expect(store.get(activeFileRepoPathAtom)).toBeNull();
  });
});
