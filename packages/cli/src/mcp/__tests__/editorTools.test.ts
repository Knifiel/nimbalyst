// @vitest-environment node
/**
 * The drawing tools on a real local wiki, with the Excalidraw extension's own
 * element factory and layout (what `editor-models.mjs` bundles). The mind map
 * code lives in its own repo and is covered by the live check.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as elementFactory from '../../../../extensions/excalidraw/src/utils/elementFactory';
import { LayoutEngine } from '../../../../extensions/excalidraw/src/layout/LayoutEngine';
import { initLocalWiki } from '../../localWiki/open.js';
import { EDITOR_MODELS_VERSION, editorTools, withOutlineIds, type EditorModels } from '../editorTools.js';
import { localWikiContext } from '../serverTools.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const models = { ...elementFactory, LayoutEngine, EDITOR_MODELS_VERSION } as unknown as EditorModels;

describe('nim mcp drawing tools', () => {
  it('adds labeled shapes and an arrow between them by label, removes a shape with its arrow, and refuses a stale write', async () => {
    const project = realpathSync(mkdtempSync(path.join(tmpdir(), 'nim-editor-tools-')));
    dirs.push(project);
    (await initLocalWiki(project)).wiki.close();
    const context = localWikiContext(project);
    const opened = await context.open();
    const created = await opened.wiki.command({ type: 'register-document', title: 'Flow', parentFolderId: null, documentType: 'excalidraw', body: '' });
    const tools = new Map(editorTools(context, async () => models).map((tool) => [tool.definition.name, tool]));
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await tools.get(name)!.call({ filePath: created.id, ...args });
      return { error: result.isError === true, value: result.isError ? result.content[0]!.text : JSON.parse(result.content[0]!.text) };
    };

    const added = await call('excalidraw_add_elements', { elements: [{ label: 'Browser' }, { label: 'nim wiki serve', color: 'blue' }] });
    expect(added.value.ids).toHaveLength(2);
    expect((await call('excalidraw_add_arrows', { arrows: [{ from: 'Browser', to: 'nim wiki serve', label: 'HTTP' }] })).error).toBe(false);

    const listed = await call('excalidraw_get_elements', {});
    const byLabel = Object.fromEntries(listed.value.elements.map((e: { label: string; id: string }) => [e.label, e]));
    expect(byLabel['nim wiki serve']).toMatchObject({ type: 'rectangle' });
    // Auto-placed shapes do not sit on top of each other.
    expect(byLabel.Browser.x !== byLabel['nim wiki serve'].x || byLabel.Browser.y !== byLabel['nim wiki serve'].y).toBe(true);
    const arrow = listed.value.elements.find((e: { type: string }) => e.type === 'arrow');
    expect([arrow.from, arrow.to]).toEqual([byLabel.Browser.id, byLabel['nim wiki serve'].id]);

    // The name the page tree shows, suffix included, finds the page too.
    const removed = await call('excalidraw_remove_elements', { elements: ['Browser'], filePath: 'Flow.excalidraw' });
    expect(removed.value.removed).toEqual(expect.arrayContaining([byLabel.Browser.id, arrow.id]));
    const after = await call('excalidraw_get_elements', {});
    expect(after.value.elements.map((e: { label: string }) => e.label).sort()).toEqual(['HTTP', 'nim wiki serve']);

    // Someone else wrote the file since this version was read: nothing is written.
    writeFileSync(path.join(opened.dir, 'Flow.excalidraw'), JSON.stringify({ elements: [] }));
    const stale = await call('excalidraw_add_elements', { elements: [{ label: 'Late' }], expectedVersion: after.value.version });
    expect(stale.error).toBe(true);
    expect(stale.value).toMatch(/changed since/);
    opened.wiki.close();
  });

  it('names mind map nodes by outline position, which survives a re-parse that makes new ids', () => {
    const node = (id: string, parentId: string | null, childIds: string[]) => ({ id, text: id, note: '', parentId, childIds, tags: [], status: 'none', color: 'default', link: '' });
    const parsed = { title: 'M', rootId: 'r_9', nodes: { r_9: node('r_9', null, ['a_1', 'b_2']), a_1: node('a_1', 'r_9', []), b_2: node('b_2', 'r_9', ['c_3']), c_3: node('c_3', 'b_2', []) } };
    const { doc, ids } = withOutlineIds(parsed);
    expect(Object.keys(doc.nodes).sort()).toEqual(['1', '2', '2.1', 'root']);
    expect(doc.nodes['2.1']).toMatchObject({ text: 'c_3', parentId: '2' });
    expect(ids.get('c_3')).toBe('2.1');
  });
});
