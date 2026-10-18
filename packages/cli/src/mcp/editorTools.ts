/**
 * Mind map and drawing pages as files: the same operations the desktop tools
 * offer (`mindmap_apply_operations`, `excalidraw_add_elements`...), run on the
 * page's file text instead of a mounted editor, so an agent outside the app
 * can build these pages. Each call reads the file, changes it with the
 * extension's own document code, and writes it back with the version it read,
 * so a page changed in between (someone editing it in the browser) is refused
 * rather than overwritten.
 *
 * The document code is the editors' own (`editor-models.mjs`, built with
 * `@nimbalyst/wiki-web` from the extensions' source), loaded from the browser
 * app's folder at first use. Without the browser app the tools say how to get it.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { LocalPage, LocalWiki } from '@nimbalyst/local-wiki';
import { usageError } from '../cli/exitCodes.js';
import type { OpenedWiki } from '../localWiki/open.js';
import { findPage, localPageUri } from '../localWiki/tree.js';
import { installHint, resolveWikiWebAssets } from '../serve/assets.js';
import { localTool, requireStr, str, type Args, type LocalWikiContext } from './localTools.js';
import type { McpTool, McpToolDefinition } from './toolMap.js';

/** Must match EDITOR_MODELS_VERSION in packages/wiki-web/scripts/editor-models.entry.mjs. */
export const EDITOR_MODELS_VERSION = 2;

type Element = Record<string, unknown> & { id: string; type: string };
interface MindmapNode { id: string; text: string; note: string; parentId: string | null; childIds: string[]; tags: string[]; status: string; color: string; link: string }
interface MindmapDocument { title: string; rootId: string; nodes: Record<string, MindmapNode> }

/** What `editor-models.mjs` exports, narrowed to what these tools call. */
export interface EditorModels {
  EDITOR_MODELS_VERSION: number;
  parseDocument(raw: string): MindmapDocument;
  createEmptyDocument(): MindmapDocument;
  serializeDocument(doc: MindmapDocument): string;
  applyMindmapOperations(doc: MindmapDocument, operations: unknown[]): { document: MindmapDocument; createdNodeIds: Record<string, string> };
  createLabeledRectangle(options: Record<string, unknown>): { rectangle: Element; text: Element };
  createText(options: Record<string, unknown>): Element;
  createFrame(options: Record<string, unknown>): Element;
  createArrow(options: Record<string, unknown>): Element[];
  LayoutEngine: new () => { addElements(elements: readonly unknown[]): void; calculateDefaultPosition(width: number, height: number): { x: number; y: number } };
  /** The editors' collaboration codecs, for the wiki move (`editorCodecs.ts` in wiki-web). */
  editorCodecs: {
    documentTypes: string[];
    writeDoc(documentType: string, doc: unknown, fileText: string, options: { roomHadState: boolean }): 'seeded' | 'applied' | 'unchanged' | 'edited';
    exportDoc(documentType: string, doc: unknown): string;
  };
  /** The desktop's document room client, bundled with the codecs so they share one yjs. */
  DocumentSyncProvider: new (config: {
    serverUrl: string;
    getJwt: (opts?: { forceRefresh?: boolean }) => Promise<string>;
    orgId: string;
    teamMemberId: string;
    documentId: string;
    onFirstSyncComplete?: (isEmpty: boolean) => void;
  }) => {
    connect(): Promise<void>;
    getYDoc(): unknown;
    flushWithAck(timeoutMs?: number): Promise<boolean>;
    getLastAuthRejectionStatus(): number | null;
    hasUndecodedContent(): boolean;
    destroy(): void;
  };
}

export type EditorModelsLoader = (opened: OpenedWiki) => Promise<EditorModels>;

export class EditorModelsUnavailable extends Error {}

/** Loads `models/editor-models.mjs` from the browser app nim would serve. */
export function editorModelsFromWikiWeb(options: { assetsDir?: string; version: string }): EditorModelsLoader {
  const loaded = new Map<string, Promise<EditorModels>>();
  return async (opened) => {
    const resolution = resolveWikiWebAssets({ flag: options.assetsDir, projectRoot: opened.projectRoot });
    if (!resolution.ok) throw new EditorModelsUnavailable(installHint(options.version, resolution));
    const file = path.join(resolution.assets.dir, 'models', 'editor-models.mjs');
    if (!existsSync(file)) {
      throw new EditorModelsUnavailable(`${resolution.assets.dir} has no models/editor-models.mjs; it is older than this nim. Run \`nim update\`, which installs the browser app published with nim.`);
    }
    let models = loaded.get(file);
    if (!models) {
      models = import(pathToFileURL(file).href) as Promise<EditorModels>;
      loaded.set(file, models);
    }
    const value = await models;
    if (value.EDITOR_MODELS_VERSION !== EDITOR_MODELS_VERSION) {
      throw new EditorModelsUnavailable(`${file} is version ${value.EDITOR_MODELS_VERSION}; this nim needs ${EDITOR_MODELS_VERSION}. Run \`nim update\`, which installs the browser app published with nim.`);
    }
    return value;
  };
}

const FILE_PATH = { type: 'string', description: 'The page: its uri from listPages (local-wiki://<id>), its id, or its path in the wiki folder.' };
const EXPECTED_VERSION = { type: 'string', description: 'Refuse the edit if the file changed since this version (from a get call or readCollabDoc).' };
const COLORS = ['default', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink'];
const STATUSES = ['none', 'idea', 'question', 'todo', 'in-progress', 'done'];

function definition(name: string, description: string, properties: Record<string, unknown>, required: string[], readOnly: boolean): McpToolDefinition {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties: { filePath: FILE_PATH, ...properties, ...(readOnly ? {} : { expectedVersion: EXPECTED_VERSION }) }, required: ['filePath', ...required] },
    annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false },
  };
}

async function editorPage(wiki: LocalWiki, args: Args, suffix: string): Promise<{ page: LocalPage; text: string; version: string }> {
  const snapshot = await wiki.snapshot();
  const ref = requireStr(args, 'filePath');
  let page: LocalPage;
  try {
    page = findPage(snapshot, ref);
  } catch (err) {
    // The tree shows an editor page with its suffix (`Flow.excalidraw`); the title is the stem.
    if (!ref.toLowerCase().endsWith(suffix)) throw err;
    page = findPage(snapshot, ref.slice(0, -suffix.length));
  }
  if (page.fileExtension !== suffix) throw usageError(`${page.title} is not a ${suffix} page (it is ${page.fileExtension})`);
  const body = await wiki.readBody(page.id);
  return { page, text: body.markdown, version: body.version };
}

async function write(wiki: LocalWiki, page: LocalPage, text: string, version: string, args: Args) {
  const expected = str(args, 'expectedVersion') ?? version;
  const result = await wiki.writeBody(page.id, text, expected);
  if (!result.ok) throw usageError(`the page changed since version ${expected} (now ${result.currentVersion}); nothing was written. Read it again and redo the edit.`);
  return { uri: localPageUri(page.id), path: page.path, version: result.version };
}

/**
 * A mind map file stores no node ids; the parser makes new ones each read. The
 * tools name nodes by outline position instead (`root`, `1`, `1.2`), which is
 * the same for every read of one file version. Returns the document with those
 * ids and the old-to-new map.
 */
export function withOutlineIds(doc: MindmapDocument): { doc: MindmapDocument; ids: Map<string, string> } {
  const ids = new Map<string, string>();
  const assign = (id: string, outline: string) => {
    ids.set(id, outline);
    (doc.nodes[id]?.childIds ?? []).forEach((child, index) => assign(child, outline === 'root' ? `${index + 1}` : `${outline}.${index + 1}`));
  };
  assign(doc.rootId, 'root');
  const rename = (id: string) => ids.get(id) ?? id;
  const nodes: Record<string, MindmapNode> = {};
  for (const node of Object.values(doc.nodes)) {
    if (!ids.has(node.id)) continue; // unreachable from the root: the serializer drops it too
    nodes[rename(node.id)] = { ...node, id: rename(node.id), parentId: node.parentId === null ? null : rename(node.parentId), childIds: node.childIds.map(rename) };
  }
  return { doc: { ...doc, rootId: 'root', nodes }, ids };
}

/** The page's mind map; an empty file (a page just created) starts from the page title. */
function readMindmap(models: EditorModels, page: LocalPage, text: string): MindmapDocument {
  if (text.trim()) return models.parseDocument(text);
  const doc = models.createEmptyDocument();
  const root = doc.nodes[doc.rootId];
  return { ...doc, title: page.title, nodes: root ? { ...doc.nodes, [doc.rootId]: { ...root, text: page.title } } : doc.nodes };
}

function nodeOutline(doc: MindmapDocument) {
  const out: Array<Record<string, unknown>> = [];
  const visit = (id: string, depth: number) => {
    const node = doc.nodes[id];
    if (!node) return;
    out.push({
      id, depth, text: node.text, parentId: node.parentId,
      ...(node.note ? { note: node.note } : {}),
      ...(node.tags.length ? { tags: node.tags } : {}),
      ...(node.status !== 'none' ? { status: node.status } : {}),
      ...(node.color !== 'default' ? { color: node.color } : {}),
      ...(node.link ? { link: node.link } : {}),
    });
    for (const child of node.childIds) visit(child, depth + 1);
  };
  visit(doc.rootId, 0);
  return out;
}

interface Scene { [key: string]: unknown; elements: Element[] }

function parseScene(text: string): Scene {
  if (!text.trim()) return { type: 'excalidraw', version: 2, source: 'https://excalidraw.com', elements: [], appState: { gridSize: null, viewBackgroundColor: '#ffffff' }, files: {} };
  const scene = JSON.parse(text) as Scene;
  if (!Array.isArray(scene.elements)) throw usageError('This drawing file has no elements array');
  return scene;
}

const live = (elements: Element[]) => elements.filter((element) => element.isDeleted !== true);

function labelOf(element: Element, elements: Element[]): string {
  if (typeof element.text === 'string' && element.text) return element.text;
  if (typeof element.name === 'string' && element.name) return element.name;
  const bound = live(elements).find((other) => other.type === 'text' && other.containerId === element.id);
  return typeof bound?.text === 'string' ? bound.text : '';
}

/** An element by id, or by its label (the shape a bound text names, not the text itself). */
function findElement(elements: Element[], ref: string): Element | undefined {
  const items = live(elements);
  const byId = items.find((element) => element.id === ref);
  if (byId) return byId;
  const labelled = items.find((element) => element.type !== 'text' && element.type !== 'arrow' && labelOf(element, elements) === ref)
    ?? items.find((element) => labelOf(element, elements) === ref);
  if (labelled?.type === 'text' && typeof labelled.containerId === 'string') return items.find((element) => element.id === labelled.containerId) ?? labelled;
  return labelled;
}

const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const COLOR_NAMES: Record<string, string> = { red: '#ffc9c9', green: '#b2f2bb', blue: '#a5d8ff', yellow: '#ffec99', orange: '#ffd8a8', purple: '#e599f7', pink: '#ffc0cb', gray: '#e9ecef', grey: '#e9ecef' };
const color = (value: unknown): string | undefined => (typeof value === 'string' && value ? COLOR_NAMES[value.toLowerCase()] ?? value : undefined);

export function editorTools(context: LocalWikiContext, loadModels: EditorModelsLoader): McpTool[] {
  const tool = (def: McpToolDefinition, run: (opened: OpenedWiki, args: Args, models: EditorModels) => Promise<unknown>): McpTool => {
    const inner = localTool(def, context, async (opened, args) => run(opened, args, await loadModels(opened)));
    return {
      definition: def,
      call: async (args) => {
        try {
          return await inner.call(args);
        } catch (err) {
          if (err instanceof EditorModelsUnavailable) return { content: [{ type: 'text', text: `${def.name}: ${err.message}` }], isError: true };
          throw err;
        }
      },
    };
  };

  return [
    tool(
      definition('mindmap_get_document', "Read a mind map page (.mindmap) as an outline: every node's id, depth, text, parent and properties, root first. Node ids are outline positions (root, 1, 1.2), valid for the returned version; pass that version to mindmap_apply_operations.", {}, [], true),
      async ({ wiki }, args, models) => {
        const { page, text, version } = await editorPage(wiki, args, '.mindmap');
        const { doc } = withOutlineIds(readMindmap(models, page, text));
        return { uri: localPageUri(page.id), title: doc.title, rootId: doc.rootId, version, nodes: nodeOutline(doc) };
      },
    ),
    tool(
      definition(
        'mindmap_apply_operations',
        'Atomically apply up to 200 add, update, delete or move operations to a mind map page and save it. Add operations may declare an alias; later operations can use it as a nodeId or parentId. Node ids are outline positions (root, 1, 1.2) from mindmap_get_document; the result lists the saved map with fresh ids, so read those rather than reusing older ones. Create the page with createSharedDoc (documentType mindmap) if it does not exist.',
        {
          operations: {
            type: 'array',
            description: 'Ordered operations. add requires parentId and text; update/delete require nodeId; move requires nodeId and newParentId.',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['add', 'update', 'delete', 'move'] },
                nodeId: { type: 'string' },
                parentId: { type: 'string' },
                newParentId: { type: 'string' },
                alias: { type: 'string' },
                text: { type: 'string' },
                note: { type: 'string' },
                link: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' } },
                color: { type: 'string', enum: COLORS },
                status: { type: 'string', enum: STATUSES },
                index: { type: 'number' },
              },
              required: ['type'],
            },
          },
        },
        ['operations'],
        false,
      ),
      async ({ wiki }, args, models) => {
        if (!Array.isArray(args.operations) || args.operations.length === 0) throw usageError('Pass at least one operation');
        const { page, text, version } = await editorPage(wiki, args, '.mindmap');
        let applied: ReturnType<EditorModels['applyMindmapOperations']>;
        try {
          applied = models.applyMindmapOperations(withOutlineIds(readMindmap(models, page, text)).doc, args.operations);
        } catch (err) {
          throw usageError((err as Error).message);
        }
        const saved = await write(wiki, page, models.serializeDocument(applied.document), version, args);
        // Report new nodes by their outline id in the saved map, which is what the next call will see.
        const { doc, ids } = withOutlineIds(applied.document);
        const createdNodeIds = Object.fromEntries(Object.entries(applied.createdNodeIds).map(([alias, id]) => [alias, ids.get(id) ?? id]));
        return { ...saved, createdNodeIds, nodes: nodeOutline(doc) };
      },
    ),
    tool(
      definition('excalidraw_get_elements', 'List the shapes, text, frames and arrows on a drawing page (.excalidraw): id, type, label, position and size, and for arrows what they connect. Returns the version to pass to the excalidraw edit tools.', {}, [], true),
      async ({ wiki }, args) => {
        const { page, text, version } = await editorPage(wiki, args, '.excalidraw');
        const scene = parseScene(text);
        const elements = live(scene.elements)
          .filter((element) => !(element.type === 'text' && typeof element.containerId === 'string'))
          .map((element) => ({
            id: element.id,
            type: element.type,
            label: labelOf(element, scene.elements),
            x: Math.round(Number(element.x) || 0),
            y: Math.round(Number(element.y) || 0),
            width: Math.round(Number(element.width) || 0),
            height: Math.round(Number(element.height) || 0),
            ...(element.type === 'arrow'
              ? { from: (element.startBinding as { elementId?: string } | null)?.elementId ?? null, to: (element.endBinding as { elementId?: string } | null)?.elementId ?? null }
              : {}),
          }));
        return { uri: localPageUri(page.id), version, elements };
      },
    ),
    tool(
      definition(
        'excalidraw_add_elements',
        'Add labeled shapes to a drawing page and save it: rectangles (rounded by default), text, or frames. Give x/y to place one; without them it goes in the next free spot. Create the page with createSharedDoc (documentType excalidraw) if it does not exist; connect shapes with excalidraw_add_arrows.',
        {
          elements: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['rectangle', 'text', 'frame'], description: 'Default rectangle.' },
                label: { type: 'string', description: 'The text in the shape, the text itself, or the frame title.' },
                x: { type: 'number' },
                y: { type: 'number' },
                width: { type: 'number', description: 'Default 150 (frames 400).' },
                height: { type: 'number', description: 'Default 80 (frames 300).' },
                color: { type: 'string', description: 'Fill: red, green, blue, yellow, orange, purple, pink, gray, or a hex color.' },
                strokeColor: { type: 'string' },
                rounded: { type: 'boolean', description: 'Rounded corners (default true).' },
              },
              required: ['label'],
            },
          },
        },
        ['elements'],
        false,
      ),
      async ({ wiki }, args, models) => {
        if (!Array.isArray(args.elements) || args.elements.length === 0) throw usageError('Pass at least one element');
        const { page, text, version } = await editorPage(wiki, args, '.excalidraw');
        const scene = parseScene(text);
        const layout = new models.LayoutEngine();
        layout.addElements(live(scene.elements));
        const ids: string[] = [];
        for (const raw of args.elements as Args[]) {
          const kind = str(raw, 'type') ?? 'rectangle';
          const label = typeof raw.label === 'string' ? raw.label : '';
          const width = num(raw.width) ?? (kind === 'frame' ? 400 : 150);
          const height = num(raw.height) ?? (kind === 'frame' ? 300 : 80);
          const at = num(raw.x) !== undefined && num(raw.y) !== undefined ? { x: num(raw.x)!, y: num(raw.y)! } : layout.calculateDefaultPosition(width, height);
          let added: Element[];
          if (kind === 'frame') added = [models.createFrame({ ...at, width, height, name: label })];
          else if (kind === 'text') added = [models.createText({ ...at, text: label, fontSize: 20 })];
          else if (kind === 'rectangle') {
            const { rectangle, text: bound } = models.createLabeledRectangle({
              ...at, width, height, text: label,
              ...(color(raw.color) ? { backgroundColor: color(raw.color) } : {}),
              ...(color(raw.strokeColor) ? { strokeColor: color(raw.strokeColor) } : {}),
              roundness: raw.rounded === false ? null : { type: 3 },
            });
            added = [rectangle, bound];
          } else throw usageError(`Unknown element type ${kind}`);
          scene.elements.push(...added);
          layout.addElements(added);
          ids.push(added[0]!.id);
        }
        const saved = await write(wiki, page, JSON.stringify(scene, null, 2), version, args);
        return { ...saved, ids };
      },
    ),
    tool(
      definition(
        'excalidraw_add_arrows',
        'Connect shapes on a drawing page with arrows and save it. from and to are element ids or labels (from excalidraw_get_elements).',
        {
          arrows: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                from: { type: 'string', description: 'Label or id of the source element.' },
                to: { type: 'string', description: 'Label or id of the target element.' },
                label: { type: 'string', description: 'Optional text on the arrow.' },
              },
              required: ['from', 'to'],
            },
          },
        },
        ['arrows'],
        false,
      ),
      async ({ wiki }, args, models) => {
        if (!Array.isArray(args.arrows) || args.arrows.length === 0) throw usageError('Pass at least one arrow');
        const { page, text, version } = await editorPage(wiki, args, '.excalidraw');
        const scene = parseScene(text);
        const ids: string[] = [];
        const missing: string[] = [];
        for (const raw of args.arrows as Args[]) {
          const from = findElement(scene.elements, requireStr(raw, 'from'));
          const to = findElement(scene.elements, requireStr(raw, 'to'));
          if (!from || !to) {
            missing.push(`${raw.from} -> ${raw.to}`);
            continue;
          }
          // Edge to edge along the line between centers, so the arrow starts and ends at the shapes, not inside them.
          const box = (element: Element) => ({ x: Number(element.x) || 0, y: Number(element.y) || 0, w: Number(element.width) || 0, h: Number(element.height) || 0 });
          const a = box(from);
          const b = box(to);
          const center = (r: typeof a) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
          const edge = (r: typeof a, toward: { x: number; y: number }) => {
            const c = center(r);
            const dx = toward.x - c.x;
            const dy = toward.y - c.y;
            const scale = 1 / Math.max(Math.abs(dx) / (r.w / 2 || 1), Math.abs(dy) / (r.h / 2 || 1), 1e-9);
            return { x: c.x + dx * Math.min(scale, 1), y: c.y + dy * Math.min(scale, 1) };
          };
          const start = edge(a, center(b));
          const end = edge(b, center(a));
          const created = models.createArrow({ startX: start.x, startY: start.y, endX: end.x, endY: end.y, startElementId: from.id, endElementId: to.id, ...(typeof raw.label === 'string' && raw.label ? { label: raw.label } : {}) });
          const arrow = created[0]!;
          for (const shape of [from, to]) shape.boundElements = [...((shape.boundElements as unknown[] | null) ?? []), { id: arrow.id, type: 'arrow' }];
          scene.elements.push(...created);
          ids.push(arrow.id);
        }
        if (ids.length === 0) throw usageError(`No arrows added; could not find ${missing.join(', ')}`);
        const saved = await write(wiki, page, JSON.stringify(scene, null, 2), version, args);
        return { ...saved, ids, ...(missing.length ? { notFound: missing } : {}) };
      },
    ),
    tool(
      definition(
        'excalidraw_remove_elements',
        'Remove elements from a drawing page by id or label and save it. A shape takes its label text and the arrows attached to it.',
        { elements: { type: 'array', items: { type: 'string' }, description: 'Element ids or labels.' } },
        ['elements'],
        false,
      ),
      async ({ wiki }, args) => {
        if (!Array.isArray(args.elements) || args.elements.length === 0) throw usageError('Pass at least one element');
        const { page, text, version } = await editorPage(wiki, args, '.excalidraw');
        const scene = parseScene(text);
        const gone = new Set<string>();
        const missing: string[] = [];
        for (const ref of args.elements) {
          const element = typeof ref === 'string' ? findElement(scene.elements, ref) : undefined;
          if (!element) {
            missing.push(String(ref));
            continue;
          }
          gone.add(element.id);
        }
        for (const element of scene.elements) {
          const bindings = [element.containerId, (element.startBinding as { elementId?: string } | null)?.elementId, (element.endBinding as { elementId?: string } | null)?.elementId];
          if (bindings.some((id) => typeof id === 'string' && gone.has(id))) gone.add(element.id);
        }
        if (gone.size === 0) throw usageError(`Nothing removed; could not find ${missing.join(', ')}`);
        scene.elements = scene.elements
          .filter((element) => !gone.has(element.id))
          .map((element) => (Array.isArray(element.boundElements)
            ? { ...element, boundElements: (element.boundElements as Array<{ id: string }>).filter((bound) => !gone.has(bound.id)) }
            : element));
        const saved = await write(wiki, page, JSON.stringify(scene, null, 2), version, args);
        return { ...saved, removed: [...gone], ...(missing.length ? { notFound: missing } : {}) };
      },
    ),
  ];
}
