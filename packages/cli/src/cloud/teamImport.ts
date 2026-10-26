/**
 * Pushes a local wiki export to a team project with `pages_import`: batches
 * paced under the server's per-user budget (40 calls / 10 s), a wait and retry
 * on 429. Between the passes, each editor page's content is written into the
 * team document pass 1 registered, and the files pages link to are uploaded.
 * Then a second pass re-sends only the bodies whose links changed once every
 * page has its team link. The server upserts on (project, source.wikiId,
 * localId), so an interrupted run re-run resumes. The local Home is named in
 * every call and lands in the project's Home page; types are placed in the
 * page tree after the first pass.
 */
import { ExitCode } from '../cli/exitCodes.js';
import { PagesToolError } from './pagesClient.js';
import type { TeamContentWriter } from './teamContent.js';
import {
  pathIndex,
  rewriteEmbedsForTeam,
  rewriteFileLinksForTeam,
  rewriteHtmlPageLinks,
  rewriteWikiLinks,
  shareCanvasCards,
  type ImportPage,
  type ImportType,
  type ImportTypePlacement,
  type LocalWikiExport,
  type TeamEmbed,
} from '../localWiki/teamExport.js';

/** Editor page types that are HTML, whose links the move points at team pages. */
const HTML_DOCUMENT_TYPES = new Set(['html', 'mockup.html']);

export interface ImportedEntry {
  nodeId: string;
  id: string;
  issueKey?: string;
  link: string;
  uri?: string;
}

export interface ImportError {
  localId: string;
  code: string;
  message: string;
}

export interface PagesImportResult {
  idMap: Record<string, ImportedEntry>;
  created: number;
  updated: number;
  errors: ImportError[];
}

export type ToolCaller = (name: string, args: Record<string, unknown>) => Promise<any>;

export interface ImportDeps {
  call: ToolCaller;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Gap between calls. 300 ms is about 33 calls per 10 s, under the budget with room for the agent's own calls. */
  minIntervalMs?: number;
  /** Attempts per call on 429 or a transient failure. */
  maxAttempts?: number;
}

export const BATCH_MAX_PAGES = 50;
/**
 * The whole serialized request, envelope included. The server takes up to
 * 1 MiB for `pages_import` (64 KB for every other tool); this leaves headroom.
 */
export const BATCH_MAX_BYTES = 900_000;
/** The JSON-RPC envelope around `arguments`, with room to spare. */
const ENVELOPE_BYTES = 256;

const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

export interface BatchPlan {
  batches: ImportPage[][];
  /** Pages that cannot fit in one request even alone. */
  tooLarge: ImportPage[];
}

/**
 * Splits pages into requests of at most `maxPages` pages and `maxBytes` bytes,
 * counting `overhead` (the request's other arguments) in each.
 */
export function planBatches(
  pages: ImportPage[],
  options: { maxPages?: number; maxBytes?: number; overhead?: number } = {},
): BatchPlan {
  const { maxPages = BATCH_MAX_PAGES, maxBytes = BATCH_MAX_BYTES, overhead = ENVELOPE_BYTES } = options;
  const batches: ImportPage[][] = [];
  const tooLarge: ImportPage[] = [];
  let current: ImportPage[] = [];
  let bytes = 0;
  const budget = maxBytes - overhead;
  for (const page of pages) {
    // +1 for the comma between array entries.
    const size = jsonBytes(page) + 1;
    if (size > budget) {
      tooLarge.push(page);
      continue;
    }
    if (current.length >= maxPages || bytes + size > budget) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(page);
    bytes += size;
  }
  if (current.length) batches.push(current);
  return { batches, tooLarge };
}

/** The server takes at most 20 types per `pages_import` call. */
export const TYPE_BATCH_MAX = 20;

/** Types in requests of their own (no pages), by count and bytes; a type too large to send alone is returned apart. */
export function planTypeBatches(
  types: ImportType[],
  { maxTypes = TYPE_BATCH_MAX, maxBytes = BATCH_MAX_BYTES, overhead = ENVELOPE_BYTES } = {},
): { batches: ImportType[][]; tooLarge: ImportType[] } {
  const batches: ImportType[][] = [];
  const tooLarge: ImportType[] = [];
  let current: ImportType[] = [];
  let bytes = 0;
  const budget = maxBytes - overhead;
  for (const type of types) {
    const size = jsonBytes(type) + 1;
    if (size > budget) {
      tooLarge.push(type);
      continue;
    }
    if (current.length >= maxTypes || bytes + size > budget) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(type);
    bytes += size;
  }
  if (current.length) batches.push(current);
  return { batches, tooLarge };
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One call at a time, spaced out, retried on 429 (after Retry-After) and on transient server trouble. */
export function pacedCaller(deps: ImportDeps): ToolCaller {
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const gap = deps.minIntervalMs ?? 300;
  const attempts = deps.maxAttempts ?? 6;
  let last = -Infinity;
  return async (name, args) => {
    for (let attempt = 1; ; attempt++) {
      const wait = last + gap - now();
      if (wait > 0) await sleep(wait);
      last = now();
      try {
        return await deps.call(name, args);
      } catch (err) {
        const limited = err instanceof PagesToolError && err.toolCode === 'rate_limited';
        const transient = err instanceof PagesToolError && !limited && err.code === ExitCode.CONNECTION;
        if ((!limited && !transient) || attempt >= attempts) throw err;
        const backoff = Math.min(1000 * 2 ** (attempt - 1), 30_000);
        await sleep(limited ? (err as PagesToolError).retryAfterMs ?? backoff : backoff);
      }
    }
  };
}

export interface ImportTarget {
  repo?: string;
  project: { orgId: string; projectId: string };
  wikiId: string;
}

export interface ImportOutcome {
  batches: number;
  created: number;
  updated: number;
  linksRewritten: number;
  /** Editor pages whose team document now reads as the local file. */
  editorPagesWritten: number;
  /** Files uploaded into the team documents of the pages that link to them. */
  filesUploaded: number;
  idMap: Record<string, ImportedEntry>;
  errors: ImportError[];
  /** Left as they are without failing the move: a link to a file that is not there, a file over the upload limit. */
  warnings: ImportError[];
  /** Every page sent was reported created or updated, with no errors and an id for each. */
  complete: boolean;
}

function asResult(value: any): PagesImportResult {
  return {
    idMap: value?.idMap && typeof value.idMap === 'object' ? value.idMap : {},
    created: Number(value?.created) || 0,
    updated: Number(value?.updated) || 0,
    errors: Array.isArray(value?.errors) ? value.errors : [],
  };
}

/**
 * The document holding a page's body, where its attachments go: a plain or
 * editor page's own document, or a typed page's `tracker-content/<itemId>`.
 */
export function bodyDocumentId(entry: ImportedEntry): string {
  return entry.nodeId.startsWith('item:') ? `tracker-content/${entry.id}` : entry.id;
}

/**
 * `call` should come from `pacedCaller`, shared with the move's other calls so
 * they are paced together. `content` writes editor pages and uploads files; an
 * export with editor pages or linked files needs one.
 */
export async function importToTeam(exported: LocalWikiExport, target: ImportTarget, call: ToolCaller, content?: TeamContentWriter): Promise<ImportOutcome> {
  const base = {
    ...(target.repo ? { repo: target.repo } : {}),
    project: target.project,
    source: { wikiId: target.wikiId },
    // Every batch names it, so the server resolves Home as a parent or a re-sent body in any of them.
    ...(exported.projectHomeLocalId ? { homeLocalId: exported.projectHomeLocalId } : {}),
  };
  const idMap: Record<string, ImportedEntry> = {};
  const errors: ImportError[] = [];
  const warnings: ImportError[] = [];
  let created = 0;
  let updated = 0;
  let batches = 0;

  const send = async (pages: ImportPage[], extra: { types?: ImportType[]; typePlacements?: ImportTypePlacement[] } = {}) => {
    const result = asResult(await call('pages_import', { ...base, ...extra, pages }));
    batches++;
    Object.assign(idMap, result.idMap);
    errors.push(...result.errors);
    return result;
  };
  const overhead = jsonBytes({ ...base, pages: [] }) + ENVELOPE_BYTES;
  const limitKb = Math.round(BATCH_MAX_BYTES / 1024);
  const tooLargeError = (page: ImportPage): ImportError => ({
    localId: page.localId,
    code: 'page_too_large',
    message: `This page is ${Math.round(jsonBytes(page) / 1024)} KB, over the ${limitKb} KB a single import request can carry; it stays in the local wiki only.`,
  });

  // Types first, in requests of their own, so every typed page finds its type.
  const typePlan = planTypeBatches(exported.types, { overhead: overhead + jsonBytes({ types: [] }) });
  for (const type of typePlan.tooLarge) {
    errors.push({
      localId: `type:${type.id}`,
      code: 'type_too_large',
      message: `The definition of type ${type.id} is ${Math.round(jsonBytes(type) / 1024)} KB, over the ${limitKb} KB a single import request can carry; its typed pages cannot be imported until it is smaller.`,
    });
  }
  for (const types of typePlan.batches) await send([], { types });

  // Pass 1: every page as written, minus relationship fields (their targets may not have team ids yet).
  // Pages come in tree order, so a page that did not make it is known before any of its children is sent;
  // those are held back (and theirs, in turn) rather than sent with a parent the server never got.
  const firstPass = planBatches(exported.pages, { overhead });
  errors.push(...firstPass.tooLarge.map(tooLargeError));
  const notImported = new Set(firstPass.tooLarge.map((page) => page.localId));
  for (const planned of firstPass.batches) {
    const batch: ImportPage[] = [];
    for (const page of planned) {
      if (page.parentLocalId && notImported.has(page.parentLocalId)) {
        notImported.add(page.localId);
        errors.push({ localId: page.localId, code: 'parent_not_imported', message: 'Its parent page was not imported, so this page stays in the local wiki only.' });
      } else batch.push(page);
    }
    if (!batch.length) continue;
    const result = await send(batch);
    created += result.created;
    updated += result.updated;
    for (const page of batch) if (!result.idMap[page.localId]) notImported.add(page.localId);
  }

  // Types into the page tree, now that the pages they sit under exist.
  const placeable: ImportTypePlacement[] = [];
  for (const placement of exported.typePlacements) {
    if (placement.parentLocalId && notImported.has(placement.parentLocalId)) {
      errors.push({ localId: `type:${placement.typeId}`, code: 'parent_not_imported', message: 'The page it sits under was not imported, so the type is not placed in the team page tree.' });
    } else placeable.push(placement);
  }
  for (let at = 0; at < placeable.length; at += TYPE_BATCH_MAX) await send([], { typePlacements: placeable.slice(at, at + TYPE_BATCH_MAX) });

  // Between the passes: editor pages' content, then the files pages link to, each into its page's team document.
  let editorPagesWritten = 0;
  let filesUploaded = 0;
  const assetUris = new Map<string, Map<string, string>>();
  if ((exported.editorFiles.size || exported.linkedFiles.size) && !content) {
    throw new Error('importToTeam: editor pages and linked files need a TeamContentWriter');
  }
  const byPath = pathIndex(exported.locations);
  const teamDocument = (localId: string) => {
    const entry = idMap[localId];
    return entry?.nodeId.startsWith('document:') ? { orgId: target.project.orgId, documentId: entry.id } : undefined;
  };
  // A page the server mapped but refused as another document type keeps its links, never a write in another editor's format.
  const typeMismatch = new Set(errors.filter((error) => error.code === 'document_type_mismatch').map((error) => error.localId));
  const linkFor = (localId: string) => idMap[localId]?.link;
  let linksRewritten = 0;
  for (const [localId, file] of exported.editorFiles) {
    const entry = idMap[localId];
    if (!entry || typeMismatch.has(localId)) continue;
    const location = exported.locations.get(localId);
    let text = file.text;
    if (file.documentType === 'canvas' && location?.path) {
      text = shareCanvasCards(text, location.path, { prefix: exported.wikiPrefix, dir: exported.wikiDir }, byPath, teamDocument).text;
    } else if (HTML_DOCUMENT_TYPES.has(file.documentType) && location) {
      const html = rewriteHtmlPageLinks(text, location, byPath, linkFor);
      text = html.text;
      linksRewritten += html.rewritten;
    }
    const written = await content!.writeEditorPage({ localId, documentId: entry.id, documentType: file.documentType, text });
    if (written.ok) editorPagesWritten++;
    else errors.push({ localId, code: written.code, message: written.message });
  }
  for (const [localId, files] of exported.linkedFiles) {
    const entry = idMap[localId];
    if (!entry) continue;
    const uris = new Map<string, string>();
    for (const file of files) {
      if (!file.abs) {
        warnings.push({ localId, code: 'linked_file_missing', message: `${file.linkPath} is not a file in the wiki, so the link is left as written.` });
        continue;
      }
      const uploaded = await content!.uploadFile({ documentId: bodyDocumentId(entry), abs: file.abs });
      if (uploaded.ok) {
        uris.set(file.linkPath, uploaded.uri);
        filesUploaded++;
      } else if (uploaded.code === 'file_too_large') {
        warnings.push({ localId, code: uploaded.code, message: `${file.linkPath}: ${uploaded.message}` });
      } else {
        errors.push({ localId, code: uploaded.code, message: `${file.linkPath}: ${uploaded.message}` });
      }
    }
    if (uris.size) assetUris.set(localId, uris);
  }

  // Pass 2: embeds become team embeds, links between pages point at their team pages, files at their uploads, and relationship fields at team ids.
  const teamId = (localId: string) => idMap[localId]?.id;
  const editorPages = new Map(exported.pages.filter((page) => page.kind === 'editorPage').map((page) => [page.localId, page]));
  const embedFor = (localId: string): TeamEmbed | undefined => {
    const fileExtension = editorPages.get(localId)?.fileExtension;
    const doc = typeMismatch.has(localId) ? undefined : teamDocument(localId);
    if (!fileExtension || !doc) return undefined;
    return { uri: `nimbalyst://doc/${encodeURIComponent(doc.documentId)}?orgId=${encodeURIComponent(doc.orgId)}`, fileExtension };
  };
  const changed: ImportPage[] = [];
  for (const page of exported.pages) {
    if (!idMap[page.localId]) continue;
    const location = exported.locations.get(page.localId);
    const embeds = location && page.body ? rewriteEmbedsForTeam(page.body, location, byPath, embedFor) : { body: page.body, rewritten: 0 };
    const pageLinks = location && embeds.body ? rewriteWikiLinks(embeds.body, location, byPath, linkFor) : { body: embeds.body, rewritten: 0 };
    const uris = assetUris.get(page.localId);
    const fileLinks = location && pageLinks.body
      ? rewriteFileLinksForTeam(pageLinks.body, location, byPath, linkFor, (linkPath) => uris?.get(linkPath))
      : { body: pageLinks.body, rewritten: 0 };
    const next = { body: fileLinks.body, rewritten: embeds.rewritten + pageLinks.rewritten + fileLinks.rewritten };
    const relations = exported.relations.get(page.localId);
    const remapped: Record<string, string | string[]> = {};
    const missing: string[] = [];
    for (const [field, value] of Object.entries(relations ?? {})) {
      const ids = Array.isArray(value) ? value : [value];
      const mapped = ids.map(teamId);
      // A target that was not imported leaves the field unset rather than pointing at a local id.
      if (mapped.some((id) => !id)) missing.push(`${field} -> ${ids.filter((_, i) => !mapped[i]).join(', ')}`);
      else remapped[field] = Array.isArray(value) ? (mapped as string[]) : mapped[0]!;
    }
    if (missing.length) {
      errors.push({
        localId: page.localId,
        code: 'relationship_target_not_imported',
        message: `Left unset because the item it points at was not imported: ${missing.join('; ')}.`,
      });
    }
    if (!next.rewritten && !Object.keys(remapped).length) continue;
    linksRewritten += next.rewritten;
    const fields = { ...(page.fields ?? {}), ...remapped };
    changed.push({ ...page, body: next.body, ...(Object.keys(fields).length ? { fields } : {}) });
  }
  const secondPass = planBatches(changed, { overhead });
  // Longer team links can push a page over the limit; it keeps its first-pass body and fields.
  errors.push(...secondPass.tooLarge.map(tooLargeError));
  for (const batch of secondPass.batches) await send(batch);

  const complete =
    errors.length === 0 &&
    created + updated === exported.pages.length &&
    exported.pages.every((page) => idMap[page.localId]);
  return { batches, created, updated, linksRewritten, editorPagesWritten, filesUploaded, idMap, errors, warnings, complete };
}
