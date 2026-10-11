// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import {
  expandedDirsAtom, fileTreeLoadedAtom, flattenTree, rawFileTreeAtom,
  workspaceRootPathsAtom, type RendererFileTreeItem,
} from '../../atoms/fileTree';
import { initFileTreeListeners } from '../fileTreeListeners';

vi.mock('../../actions/workspaceFolders', () => ({ attachWorkspaceFolderWithPicker: vi.fn() }));

type Tree = RendererFileTreeItem[];
const paths = Array.from({ length: 20 }, (_, i) => '/proj/' +
  Array.from({ length: i + 1 }, (_, j) => `d${j + 1}`).join('/'));
const leaf = (name: string): Tree => [{ name, path: `${paths[19]}/${name}`, type: 'file' }];

function chain(first: number, last: number, children: Tree = [], truncated = false): Tree {
  let nodes = children;
  for (let depth = last; depth >= first; depth--) {
    nodes = [{ name: `d${depth}`, path: paths[depth - 1], type: 'directory', children: nodes,
      ...(depth === last && truncated ? { childrenTruncated: true } : {}) }];
  }
  return nodes;
}

function deferred() {
  let resolve!: (tree: Tree) => void;
  const promise = new Promise<Tree>(done => { resolve = done; });
  return { promise, resolve };
}

let update: (data: { fileTree: Tree; rootPath?: string }) => void;
let cleanup: () => void;
const refresh = vi.fn<(path: string) => Promise<Tree>>();

beforeEach(async () => {
  refresh.mockReset();
  store.set(workspaceRootPathsAtom, []);
  store.set(fileTreeLoadedAtom, false);
  store.set(expandedDirsAtom, new Set(paths));
  vi.stubGlobal('window', { electronAPI: {
    invoke: async () => ({ success: true, folders: ['/proj'] }),
    getFolderContents: async () => chain(1, 20, leaf('old.ts')),
    refreshFolderContents: refresh,
    onWorkspaceFileTreeUpdated: (callback: typeof update) => { update = callback; return () => {}; },
    on: () => () => {},
  } });
  cleanup = initFileTreeListeners('/proj');
  await vi.waitFor(() => expect(store.get(fileTreeLoadedAtom)).toBe(true));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function visibleFiles(): string[] {
  return flattenTree({ items: store.get(rawFileTreeAtom), expanded: store.get(expandedDirsAtom),
    activeFile: null, selectedFolder: null, selectedPaths: new Set(), dragState: null })
    .filter(node => node.type === 'file').map(node => node.name);
}

it('keeps the loaded leaf beyond d18 visible until recursive refresh replaces it', async () => {
  const d9 = deferred();
  const d18 = deferred();
  refresh.mockImplementation(folder => folder === paths[8] ? d9.promise : d18.promise);
  update({ fileTree: chain(1, 9, [], true) });
  expect(visibleFiles()).toEqual(['old.ts']);

  d9.resolve(chain(10, 18, [], true));
  await d9.promise;
  expect(visibleFiles()).toEqual(['old.ts']);
  expect(refresh.mock.calls.map(([folder]) => folder)).toEqual([paths[8], paths[17]]);

  d18.resolve(chain(19, 20, leaf('new.ts')));
  await vi.waitFor(() => expect(visibleFiles()).toEqual(['new.ts']));
});

it('ignores an older refresh that finishes after a newer watcher refresh', async () => {
  const older = deferred();
  const newer = deferred();
  refresh.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
  update({ fileTree: chain(1, 9, [], true) });
  update({ fileTree: chain(1, 9, [], true) });

  newer.resolve(chain(10, 20, leaf('new.ts')));
  await vi.waitFor(() => expect(visibleFiles()).toEqual(['new.ts']));
  older.resolve(chain(10, 20, leaf('deleted.ts')));
  await older.promise;
  expect(visibleFiles()).toEqual(['new.ts']);
});
