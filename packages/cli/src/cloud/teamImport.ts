/**
 * Pushes a local wiki export to a team project with `pages_import`: batches
 * paced under the server's per-user budget (40 calls / 10 s), a wait and retry
 * on 429, then a second pass that re-sends only the bodies whose links changed
 * once every page has its team link. The server upserts on
 * (project, source.wikiId, localId), so an interrupted run re-run resumes.
 */
import { ExitCode } from '../cli/exitCodes.js';
import { PagesToolError } from './pagesClient.js';
import { pathIndex, rewriteWikiLinks, type ImportPage, type ImportType, type LocalWikiExport } from '../localWiki/teamExport.js';

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
  idMap: Record<string, ImportedEntry>;
  errors: ImportError[];
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

/** `call` should come from `pacedCaller`, shared with the move's other calls so they are paced together. */
export async function importToTeam(exported: LocalWikiExport, target: ImportTarget, call: ToolCaller): Promise<ImportOutcome> {
  const base = {
    ...(target.repo ? { repo: target.repo } : {}),
    project: target.project,
    source: { wikiId: target.wikiId },
  };
  const idMap: Record<string, ImportedEntry> = {};
  const errors: ImportError[] = [];
  let created = 0;
  let updated = 0;
  let batches = 0;

  const send = async (pages: ImportPage[], types?: ImportType[]) => {
    const result = asResult(await call('pages_import', { ...base, ...(types ? { types } : {}), pages }));
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
  for (const types of typePlan.batches) await send([], types);

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

  // Pass 2: links between pages point at their team pages, and relationship fields at team ids.
  const byPath = pathIndex(exported.locations);
  const linkFor = (localId: string) => idMap[localId]?.link;
  const teamId = (localId: string) => idMap[localId]?.id;
  const changed: ImportPage[] = [];
  let linksRewritten = 0;
  for (const page of exported.pages) {
    if (!idMap[page.localId]) continue;
    const location = exported.locations.get(page.localId);
    const next = location && page.body ? rewriteWikiLinks(page.body, location, byPath, linkFor) : { body: page.body, rewritten: 0 };
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
  return { batches, created, updated, linksRewritten, idMap, errors, complete };
}
