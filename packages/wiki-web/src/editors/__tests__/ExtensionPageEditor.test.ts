// @vitest-environment jsdom
import { act, Component, createElement, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EditorHost } from '../../host/wikiFileEditorHost';

const disk = vi.hoisted(() => ({ text: '', version: 1 }));

vi.mock('../../api/client', () => ({
  wikiApi: {
    readBody: async () => ({ markdown: disk.text, version: `v${disk.version}` }),
    writeBody: async (_id: string, next: string) => {
      disk.text = next;
      disk.version += 1;
      return { ok: true, version: `v${disk.version}` };
    },
  },
  wikiChanges: { subscribe: () => () => {} },
}));
vi.mock('../../theme', () => ({ currentTheme: () => 'light', onThemeChange: () => () => {} }));

/** Like Excalidraw: the scene lives in a class component that empties it in `componentWillUnmount`. */
class Scene extends Component<{ initial: string; onApi: (api: Scene) => void }> {
  elements = this.props.initial;
  componentDidMount() {
    this.props.onApi(this);
  }
  componentWillUnmount() {
    this.elements = '';
  }
  render() {
    return null;
  }
}

let editHandle: (() => void) | null = null;

function FakeDrawingEditor({ host }: { host: EditorHost }) {
  // Held like `excalidrawAPIRef`: set once by the editor, never cleared on unmount.
  const scene = useRef<Scene | null>(null);
  useEffect(() => {
    editHandle = () => {
      scene.current!.elements = 'edited';
      host.setDirty(true);
    };
    return host.onSaveRequested(async () => {
      await host.saveContent(scene.current!.elements);
    });
  }, [host]);
  return createElement(Scene, { initial: disk.text, onApi: (api) => (scene.current = api) });
}

vi.mock('@nimbalyst/web-editors/registry', () => ({
  loadBrowserExtension: async () => ({ components: { Drawing: FakeDrawingEditor } }),
}));

const { ExtensionPageEditor } = await import('../ExtensionPageEditor');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function mountDrawing() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(ExtensionPageEditor, {
      pageId: 'p1',
      fileName: 'flow.excalidraw',
      filePath: 'flow.excalidraw',
      editor: { extensionId: 'excalidraw', component: 'Drawing', displayName: 'Drawing' },
    }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return root;
}

afterEach(() => {
  editHandle = null;
  document.body.innerHTML = '';
});

describe('ExtensionPageEditor leaving a page', () => {
  it('writes nothing when the page was opened and left without edits', async () => {
    disk.text = 'three elements';
    disk.version = 1;
    const root = await mountDrawing();
    await act(async () => root.unmount());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(disk.text).toBe('three elements');
    expect(disk.version).toBe(1);
  });

  it('writes the edited scene, not the one the editor emptied on unmount', async () => {
    disk.text = 'three elements';
    disk.version = 1;
    const root = await mountDrawing();
    expect(editHandle).not.toBeNull();
    await act(async () => editHandle!()); // left before the autosave pause ends
    await act(async () => root.unmount());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(disk.text).toBe('edited');
  });
});
