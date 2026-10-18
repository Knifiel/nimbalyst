/**
 * The `nim wiki serve` REST API (see packages/cli/src/serve/api.ts). The
 * session cookie set by the server's first redirect authorizes every call, so
 * nothing here handles the token.
 */
import type {
  ActivityEntry,
  LocalSearchHit,
  LocalTrackerCommand,
  LocalTrackerSnapshot,
  LocalWikiChange,
  LocalWikiCommand,
  LocalWikiCommandResult,
  LocalWikiSnapshot,
  ReadBodyResult,
  WikiFieldDef,
  WriteBodyResult,
} from '@nimbalyst/local-wiki';

/** Must match `WIKI_API_VERSION` in the server and `nimbalystWikiApi` in package.json. */
export const WIKI_API_VERSION = 1;

export interface WikiInfo {
  apiVersion: number;
  version: string;
  root: string;
  projectRoot: string | null;
}

export interface WikiTypeInfo {
  typeId: string;
  displayName: string;
  displayNamePlural: string;
  storage: 'pages' | 'table';
  fields: WikiFieldDef[];
  titleField: string;
  /** The type YAML as parsed, or null when it did not parse. */
  definition: Record<string, unknown> | null;
  /** Problems in the type file to fix, such as a field name Nimbalyst reserves. Absent from older servers. */
  problems?: string[];
}

export class WikiApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'WikiApiError';
  }
}

async function request<T>(method: string, route: string, body?: unknown): Promise<{ status: number; value: T }> {
  const res = await fetch(route, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = (await res.json().catch(() => null)) as T & { error?: { code?: string; message?: string } };
  if (!res.ok && res.status !== 409) {
    throw new WikiApiError(res.status, value?.error?.code ?? 'http', value?.error?.message ?? `${method} ${route} failed with ${res.status}`);
  }
  return { status: res.status, value };
}

const id = (value: string) => encodeURIComponent(value);

export const wikiApi = {
  info: async () => (await request<WikiInfo>('GET', '/api/info')).value,
  snapshot: async () => (await request<LocalWikiSnapshot>('GET', '/api/snapshot')).value,
  command: async (cmd: LocalWikiCommand) => (await request<LocalWikiCommandResult>('POST', '/api/command', cmd)).value,
  readBody: async (pageId: string) => (await request<ReadBodyResult>('GET', `/api/pages/${id(pageId)}/body`)).value,
  /** A 409 comes back as `{ ok: false, reason: 'conflict', ... }`, not a throw. */
  writeBody: async (pageId: string, markdown: string, expectedVersion: string | null) =>
    (await request<WriteBodyResult>('PUT', `/api/pages/${id(pageId)}/body`, { markdown, expectedVersion })).value,
  types: async () => (await request<{ types: WikiTypeInfo[] }>('GET', '/api/types')).value.types,
  /** Table type to page storage: one page per row, ids kept. */
  convertTypeToPages: async (typeId: string) =>
    (await request<{ converted: string[] }>('POST', `/api/types/${id(typeId)}/convert`, { storage: 'pages' })).value.converted,
  trackerSnapshot: async (typeId: string) => (await request<LocalTrackerSnapshot>('GET', `/api/trackers/${id(typeId)}`)).value,
  trackerCommand: async (typeId: string, cmd: LocalTrackerCommand) =>
    (await request<LocalWikiCommandResult>('POST', `/api/trackers/${id(typeId)}/command`, cmd)).value,
  activity: async (itemId: string) => (await request<{ entries: ActivityEntry[] }>('GET', `/api/items/${id(itemId)}/activity`)).value.entries,
  search: async (q: string, limit?: number) =>
    (await request<{ hits: LocalSearchHit[] }>('GET', `/api/search?q=${encodeURIComponent(q)}${limit ? `&limit=${limit}` : ''}`)).value.hits,
  /** Stores a file in the page's `.assets/` folder; `link` is what the page body writes. */
  storeAttachment: async (pageId: string, name: string, file: Blob): Promise<{ path: string; link: string }> => {
    const res = await fetch(`/api/pages/${id(pageId)}/attachments?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    const value = (await res.json().catch(() => null)) as { path: string; link: string; error?: { code?: string; message?: string } } | null;
    if (!res.ok || !value) throw new WikiApiError(res.status, value?.error?.code ?? 'http', value?.error?.message ?? `Attaching ${name} failed with ${res.status}`);
    return value;
  },
  /** URL of a file a page links to, given the link as written in the page (relative, possibly percent-encoded). */
  pageFileUrl: (pageId: string, linkPath: string) =>
    `/api/pages/${id(pageId)}/file?path=${encodeURIComponent(linkPath.split('/').map(safeDecode).join('/'))}`,
};

function safeDecode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

export type WikiFeedEvent = { type: 'change'; change: LocalWikiChange } | { type: 'types' } | { type: 'ready' } | { type: 'down' };

/**
 * One EventSource for the whole tab. `ready` fires on every (re)connect, so
 * listeners refetch then: anything that changed while the stream was down
 * arrives as a fresh snapshot rather than as the events that were missed.
 */
export class WikiChangeFeed {
  private source: EventSource | null = null;
  private readonly listeners = new Set<(event: WikiFeedEvent) => void>();
  private reachable = true;

  /**
   * False from a stream error until the next `ready`. The server lives in the
   * agent's MCP process, so it stops when that session ends; the EventSource
   * keeps retrying and a restarted server on the same port reconnects it.
   */
  isReachable(): boolean {
    return this.reachable;
  }

  subscribe(listener: (event: WikiFeedEvent) => void): () => void {
    this.listeners.add(listener);
    this.open();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.close();
    };
  }

  private emit(event: WikiFeedEvent): void {
    if (event.type === 'down') this.reachable = false;
    else if (event.type === 'ready') this.reachable = true;
    for (const listener of [...this.listeners]) listener(event);
  }

  private open(): void {
    if (this.source) return;
    const source = new EventSource('/api/events', { withCredentials: true });
    source.addEventListener('ready', () => this.emit({ type: 'ready' }));
    source.addEventListener('change', (event) => {
      try {
        this.emit({ type: 'change', change: JSON.parse((event as MessageEvent<string>).data) as LocalWikiChange });
      } catch {
        // A frame that does not parse is skipped; the next one carries the state.
      }
    });
    // A type file changed: definitions, not items, so listeners reread /api/types.
    source.addEventListener('types', () => this.emit({ type: 'types' }));
    source.onerror = () => this.emit({ type: 'down' });
    this.source = source;
  }

  private close(): void {
    this.source?.close();
    this.source = null;
  }
}

export const wikiChanges = new WikiChangeFeed();
