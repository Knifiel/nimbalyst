/**
 * The extension registry of a browser app (the web console, the local wiki's
 * browser view). Each app registers its own pins into it; the registry itself
 * is a module-level singleton per page.
 *
 * The Electron renderer has an extension loader that reads a manifest, imports
 * a bundle, calls `activate(context)` and holds the results. A browser cannot
 * install anything, so this registry holds a fixed set of build-time pins — but
 * it keeps the same two-stage shape as the desktop loader, and for the same
 * reason:
 *
 *   - a **declaration** (the manifest) is available immediately and is cheap.
 *     It is what lets the document-type catalog know a `.csv` document has an
 *     owner without downloading a spreadsheet to find out.
 *   - the **bundle** is imported only when something actually opens one of its
 *     file types. It carries the editor component and the codec, and it is
 *     hundreds of kilobytes.
 *
 * Adding an extension is a row in `pinnedExtensions.mjs` plus the app's
 * dependency on it; nothing here changes.
 *
 * **A pin is a trust decision, not a convenience.** `load()` imports code into
 * this page's realm, where it shares a `window`, an origin and a module graph
 * with the app -- in the console, therefore with the team JWT; in the wiki's
 * browser view, with the session cookie that can write the wiki folder. The
 * browser `EditorHost` capability table constrains what the host does *for* a
 * bundle; it constrains nothing the bundle does for itself. Build-time pinning
 * is what makes that safe: a pinned bundle is built from a first-party package
 * by the app's own build (the console's refuses dirty `link:` inputs and
 * records source provenance).
 *
 * So a `load()` that resolves a URL -- a marketplace registry, a version the
 * server names, anything a document or a user can influence -- is a different
 * security posture than this file has today, and needs an isolation boundary
 * (iframe or Worker, host reached over `postMessage`) before it ships. See
 * `browserEditorCapabilities.ts` and the "Browser codec hosts" section of
 * `docs/EXTENSION_ARCHITECTURE.md` in the stravu-editor repo.
 */

import type { ExtensionEditorComponent } from '@nimbalyst/collab-bundle/editor';
import type { BrowserExtensionPermissions } from '@nimbalyst/collab-bundle/editor';

/** A `customEditors` entry, narrowed to what a browser host reads. */
export interface BrowserExtensionEditorContribution {
  /** Glob patterns, e.g. `*.csv`. Only `*.<suffix>` forms are honoured here. */
  filePatterns: string[];
  displayName: string;
  /** Key into the bundle's `components` export. */
  component: string;
  /**
   * The editor declares a raw-source escape hatch, the same field the desktop
   * host reads. Read straight from the extension's own `manifest.json`, so an
   * editor that offers source mode on the desktop offers it here too without a
   * second list to keep in step.
   *
   * It is a declaration, not a guarantee: the console additionally needs a
   * codec that can project this document to text and read it back, which only
   * a loaded bundle can supply. See `ExtensionEditorMount`.
   */
  supportsSourceMode?: boolean;
  collaboration?: {
    supported?: boolean;
    /**
     * The document type this editor's codec registers, when it differs from the
     * primary file suffix. The catalog needs it before any bundle is imported.
     */
    documentType?: string;
    /** Why this editor opts out; shown instead of the generic refusal. */
    unsupportedReason?: string;
  };
}

export interface BrowserExtensionNewFileContribution {
  extension: string;
  displayName: string;
  icon: string;
  defaultContent?: string;
  action?: string;
}

/** The manifest fields a browser host consumes. Everything else is ignored. */
export interface BrowserExtensionManifest {
  id: string;
  name: string;
  version?: string;
  permissions?: BrowserExtensionPermissions;
  contributions?: {
    customEditors?: BrowserExtensionEditorContribution[];
    newFileMenu?: BrowserExtensionNewFileContribution[];
    fileIcons?: Record<string, string>;
  };
  marketplace?: { icon?: string };
}

/**
 * A content codec, structurally narrowed from the SDK's `CollabCodec`.
 *
 * Typed structurally rather than imported: the console has no dependency on
 * `@nimbalyst/extension-sdk`, and this is exactly the surface a browser host
 * uses — seeding a first-open document, projecting one back out, and (for
 * source mode) writing an edited projection back in.
 */
export interface BrowserCollabCodec {
  documentType: string;
  fileExtensions: string[];
  layoutVersion?: number;
  isEmpty(yDoc: unknown): boolean;
  seedFromFile(yDoc: unknown, source: string | Uint8Array): void;
  /**
   * Source mode's write path, and the reason it can exist at all: the codec
   * contract requires this to be safe on a populated Y.Doc and to consume its
   * own `exportToFile` output unchanged, which is exactly the round trip source
   * mode performs. Every registered adapter is asserted against that round trip
   * in the host's `codecOnlyHeadlessEdit.test.ts`.
   */
  applyFromFile(yDoc: unknown, source: string | Uint8Array): void;
  exportToFile(yDoc: unknown): string | Uint8Array;
  toPlainText(yDoc: unknown): string;
}

/** What the console needs out of a loaded bundle. */
export interface LoadedBrowserExtension {
  components: Record<string, ExtensionEditorComponent>;
  codecs: BrowserCollabCodec[];
}

export type BrowserExtensionLoadState =
  | { status: 'declared' }
  | { status: 'loading' }
  | { status: 'loaded'; loaded: LoadedBrowserExtension }
  | { status: 'failed'; error: Error };

export interface BrowserExtensionEntry {
  manifest: BrowserExtensionManifest;
  state: BrowserExtensionLoadState;
}

export interface BrowserExtensionRegistration {
  manifest: BrowserExtensionManifest;
  /**
   * Import the bundle. The registry calls this at most once per extension and
   * caches the promise, because a bundle that registers a custom element (the
   * spreadsheet registers `<revo-grid>`) must evaluate exactly once per page.
   */
  load(): Promise<unknown>;
}

interface RegistryRecord {
  registration: BrowserExtensionRegistration;
  state: BrowserExtensionLoadState;
  pending?: Promise<LoadedBrowserExtension>;
}

const records = new Map<string, RegistryRecord>();
const listeners = new Set<() => void>();
/**
 * Bumped on every registry change, and returned as the `useSyncExternalStore`
 * snapshot. The entry list is rebuilt on read, so a fresh array each time would
 * make React re-render forever; a number cannot.
 */
let revision = 0;

function notify(): void {
  revision += 1;
  for (const listener of listeners) listener();
}

export function registerBrowserExtension(registration: BrowserExtensionRegistration): void {
  const existing = records.get(registration.manifest.id);
  // Re-registering the same pin is a no-op rather than a reset: hot reload runs
  // module side effects again, and dropping a loaded bundle's components would
  // strand every editor mounted from them.
  if (existing) return;
  records.set(registration.manifest.id, { registration, state: { status: 'declared' } });
  notify();
}

export function listBrowserExtensions(): BrowserExtensionEntry[] {
  return [...records.values()].map(({ registration, state }) => ({
    manifest: registration.manifest,
    state,
  }));
}

export function getBrowserExtension(extensionId: string): BrowserExtensionEntry | null {
  const record = records.get(extensionId);
  return record ? { manifest: record.registration.manifest, state: record.state } : null;
}

export function onBrowserExtensionsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getBrowserExtensionsRevision(): number {
  return revision;
}

/** The codec registered for a document type by whichever bundle is loaded. */
export function getBrowserCollabCodec(documentType: string): BrowserCollabCodec | null {
  for (const record of records.values()) {
    if (record.state.status !== 'loaded') continue;
    const match = record.state.loaded.codecs.find(
      (codec) => codec.documentType === documentType,
    );
    if (match) return match;
  }
  return null;
}

function isBrowserCollabCodec(value: unknown): value is BrowserCollabCodec {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<BrowserCollabCodec>;
  return typeof candidate.documentType === 'string'
    && Array.isArray(candidate.fileExtensions)
    && typeof candidate.isEmpty === 'function'
    && typeof candidate.seedFromFile === 'function'
    && typeof candidate.applyFromFile === 'function'
    && typeof candidate.exportToFile === 'function'
    && typeof candidate.toPlainText === 'function';
}

/**
 * Run the bundle's `activate()` against a browser-shaped activation context.
 *
 * This is the browser answer to `context.services.collab.registerContentAdapter`
 * — the same call the extension already makes on desktop, answered by a context
 * that offers only the services a browser host can honour. An extension that
 * reaches past `services.collab` fails here rather than silently half-activating,
 * so its codecs are collected from its named exports instead and the reason is
 * logged.
 */
function activateBundle(
  extensionId: string,
  namespace: Record<string, unknown>,
): BrowserCollabCodec[] {
  const codecs: BrowserCollabCodec[] = [];
  const context = {
    services: {
      collab: {
        registerContentAdapter: (codec: BrowserCollabCodec) => {
          codecs.push(codec);
          return () => {
            const index = codecs.indexOf(codec);
            if (index >= 0) codecs.splice(index, 1);
          };
        },
      },
    },
  };

  const activate = namespace.activate;
  if (typeof activate === 'function') {
    try {
      // `activate` may be async. Its codec registrations are synchronous by
      // contract, so the codecs collected above are already complete; only a
      // late rejection is reported.
      void Promise.resolve((activate as (ctx: unknown) => unknown)(context)).catch(
        (error: unknown) => {
          console.warn(`[browserExtensions] ${extensionId} activation rejected`, error);
        },
      );
    } catch (error) {
      console.warn(`[browserExtensions] ${extensionId} activation threw`, error);
    }
  }

  // Fallback for a bundle whose activation could not complete in a browser: the
  // codec is a pure object, so an exported one is just as usable as a registered
  // one, and dropping it would make an openable document type look unsupported.
  for (const value of Object.values(namespace)) {
    if (!isBrowserCollabCodec(value)) continue;
    if (codecs.some((codec) => codec.documentType === value.documentType)) continue;
    codecs.push(value);
  }
  return codecs;
}

function readComponents(
  namespace: Record<string, unknown>,
): Record<string, ExtensionEditorComponent> {
  const components = namespace.components;
  if (!components || typeof components !== 'object') return {};
  return components as Record<string, ExtensionEditorComponent>;
}

/**
 * Import an extension's bundle and publish what it contributes.
 *
 * Concurrent callers share one import; a failure is recorded rather than
 * retried, because a bundle that failed to evaluate may have left a partially
 * registered custom element behind and re-importing it would not be clean.
 */
export function loadBrowserExtension(extensionId: string): Promise<LoadedBrowserExtension> {
  const record = records.get(extensionId);
  if (!record) {
    return Promise.reject(new Error(`No browser extension is registered as "${extensionId}"`));
  }
  if (record.state.status === 'loaded') return Promise.resolve(record.state.loaded);
  if (record.state.status === 'failed') return Promise.reject(record.state.error);
  if (record.pending) return record.pending;

  record.state = { status: 'loading' };
  notify();
  record.pending = record.registration.load().then((namespace) => {
    const module = (namespace ?? {}) as Record<string, unknown>;
    const loaded: LoadedBrowserExtension = {
      components: readComponents(module),
      codecs: activateBundle(extensionId, module),
    };
    record.state = { status: 'loaded', loaded };
    notify();
    return loaded;
  }).catch((cause: unknown) => {
    const error = cause instanceof Error
      ? cause
      : new Error(`The "${extensionId}" extension bundle could not be loaded.`);
    record.state = { status: 'failed', error };
    notify();
    throw error;
  });
  return record.pending;
}

/** Drop all registrations. Tests only — the app registers its pins once. */
export function resetBrowserExtensionRegistryForTests(): void {
  records.clear();
  notify();
}
