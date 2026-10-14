// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { WikiFeedEvent } from '../../api/client';
import { createWikiFileEditorHost, WikiFileConflictError, type WikiBodyApi } from '../wikiFileEditorHost';

/** One file on "disk", versioned like the server: a write with a stale version is refused. */
function fakeWiki(initial: string) {
  let text = initial;
  let n = 1;
  const listeners = new Set<(event: WikiFeedEvent) => void>();
  const emit = () => {
    for (const listener of listeners) listener({ type: 'change', change: { changedIds: ['p1'], removedIds: [], tableTypes: [] } });
  };
  const api: WikiBodyApi = {
    readBody: vi.fn(async () => ({ markdown: text, version: `v${n}` })),
    writeBody: vi.fn(async (_id: string, next: string, expected: string | null) => {
      if (expected !== null && expected !== `v${n}`) return { ok: false as const, reason: 'conflict' as const, currentVersion: `v${n}`, markdown: text };
      text = next;
      n += 1;
      emit(); // the watcher reports our own write too
      return { ok: true as const, version: `v${n}` };
    }),
  };
  return {
    api,
    changes: { subscribe: (listener: (event: WikiFeedEvent) => void) => (listeners.add(listener), () => listeners.delete(listener)) },
    /** Someone else (an agent, a shell) writes the file. */
    writeOutside(next: string) {
      text = next;
      n += 1;
      emit();
    },
    text: () => text,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createWikiFileEditorHost', () => {
  it('saves, ignores its own echo, reloads outside edits, and holds a conflict until the person chooses', async () => {
    const wiki = fakeWiki('{"a":1}');
    const host = createWikiFileEditorHost({ pageId: 'p1', fileName: 'x.excalidraw', filePath: 'x.excalidraw', theme: 'dark', api: wiki.api, changes: wiki.changes, autosaveDelayMs: 5 });
    const received: string[] = [];
    host.onFileChanged((text) => received.push(text));
    // The editor's side of the lifecycle: save its current text when asked.
    let editorText = await host.loadContent();
    host.onSaveRequested(async () => {
      await host.saveContent(editorText);
      host.setDirty(false);
    });

    // An edit autosaves; the change event for our own write is not delivered back.
    editorText = '{"a":2}';
    host.setDirty(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await flush();
    expect(wiki.text()).toBe('{"a":2}');
    expect(received).toEqual([]);
    expect(host.getState()).toMatchObject({ dirty: false, conflict: null });

    // An outside edit with nothing unsaved goes straight to the editor.
    wiki.writeOutside('{"a":3}');
    await flush();
    await flush();
    expect(received).toEqual(['{"a":3}']);
    editorText = '{"a":3}';

    // An outside edit while unsaved edits are open is a conflict, not a reload.
    host.setDirty(true);
    editorText = '{"a":4}';
    wiki.writeOutside('{"a":"agent"}');
    await flush();
    await flush();
    expect(received).toEqual(['{"a":3}']);
    expect(host.getState().conflict).toEqual({ diskText: '{"a":"agent"}', diskVersion: 'v4' });
    await expect(host.saveContent(editorText)).rejects.toBeInstanceOf(WikiFileConflictError);
    expect(wiki.text()).toBe('{"a":"agent"}');

    // Keep mine: written over the version now on disk.
    await host.resolveConflict('mine');
    expect(wiki.text()).toBe('{"a":4}');
    expect(host.getState().conflict).toBeNull();
    host.dispose();
  });

  it('does not ask the editor to save a page with no edits', async () => {
    const wiki = fakeWiki('{"elements":[1]}');
    const host = createWikiFileEditorHost({ pageId: 'p1', fileName: 'x.excalidraw', filePath: 'x.excalidraw', theme: 'dark', api: wiki.api, changes: wiki.changes });
    await host.loadContent();
    const save = vi.fn(async () => {
      await host.saveContent('{"elements":[]}');
    });
    host.onSaveRequested(save);

    // Opening a page and leaving it (Cmd+S, pagehide, unmount) writes nothing.
    await host.requestSave();
    expect(save).not.toHaveBeenCalled();
    expect(wiki.text()).toBe('{"elements":[1]}');

    host.setDirty(true);
    await host.requestSave();
    expect(save).toHaveBeenCalledTimes(1);
    host.dispose();
  });

  it('turns a stale save into a conflict and loads the file on "theirs"', async () => {
    const wiki = fakeWiki('a');
    const host = createWikiFileEditorHost({ pageId: 'p1', fileName: 'x.mindmap', filePath: 'x.mindmap', theme: 'light', api: wiki.api, changes: { subscribe: () => () => {} } });
    const received: string[] = [];
    host.onFileChanged((text) => received.push(text));
    await host.loadContent();
    wiki.writeOutside('b'); // the feed is down, so only the write finds out

    await expect(host.saveContent('mine')).rejects.toBeInstanceOf(WikiFileConflictError);
    expect(wiki.text()).toBe('b');
    expect(host.getState().conflict).toEqual({ diskText: 'b', diskVersion: 'v2' });

    await host.resolveConflict('theirs');
    expect(received).toEqual(['b']);
    // A successful write leaves the page clean even when the editor never says so (Monaco).
    host.setDirty(true);
    await host.saveContent('next');
    expect(wiki.text()).toBe('next');
    expect(host.getState().dirty).toBe(false);
    host.dispose();
  });
});
