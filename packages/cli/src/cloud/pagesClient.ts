/**
 * Calls the Pages tools on the sync server: `POST /mcp` (JSON-RPC
 * `tools/call`, stateless Streamable HTTP) with our bearer.
 */
import { CliError, ExitCode, connectionError } from '../cli/exitCodes.js';
import { authedFetch } from './auth.js';

let nextId = 1;

export class PagesToolError extends CliError {
  readonly toolCode?: string;
  /** `rate_limited` only: how long the server asked us to wait (Retry-After), when it said. */
  readonly retryAfterMs?: number;
  constructor(code: (typeof ExitCode)[keyof typeof ExitCode], message: string, toolCode?: string, retryAfterMs?: number) {
    super(code, message);
    this.toolCode = toolCode;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Retry-After in seconds (the only form our server sends), as ms; undefined when absent or junk. */
function retryAfterMs(res: Response): number | undefined {
  const seconds = Number(res.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 120) * 1000 : undefined;
}

/** Server tool error codes, by what the caller can do about them. */
const TOOL_ERROR_EXIT: Record<string, (typeof ExitCode)[keyof typeof ExitCode]> = {
  admin_required: ExitCode.WRITE_NOT_PERMITTED,
  project_not_accessible: ExitCode.WRITE_NOT_PERMITTED,
  repo_not_bound: ExitCode.USAGE,
  pin_mismatch: ExitCode.USAGE,
  ambiguous_project: ExitCode.USAGE,
  not_a_member: ExitCode.WRITE_NOT_PERMITTED,
  revision_conflict: ExitCode.USAGE,
  body_edited: ExitCode.USAGE,
};

/** Codes where `nim wiki status` shows the user how this repo resolves. */
const STATUS_HINT_CODES = new Set(['repo_not_bound', 'ambiguous_project', 'pin_mismatch']);

/**
 * A tool error means the server answered, so it is a connection failure only
 * when the code says the server itself is in trouble. Codes not in the table
 * fall back on their shape, then on USAGE.
 */
function exitCodeForTool(toolCode: string | undefined): (typeof ExitCode)[keyof typeof ExitCode] {
  if (!toolCode) return ExitCode.USAGE;
  if (TOOL_ERROR_EXIT[toolCode] !== undefined) return TOOL_ERROR_EXIT[toolCode];
  if (/not_found/.test(toolCode)) return ExitCode.NOT_FOUND;
  if (/forbidden|not_a_member|permission|denied/.test(toolCode)) return ExitCode.WRITE_NOT_PERMITTED;
  // Transient server-side trouble is still worth retrying.
  if (/unavailable|timeout|internal/.test(toolCode)) return ExitCode.CONNECTION;
  return ExitCode.USAGE;
}

/**
 * JSON-RPC protocol errors: the standard request-shape codes are the caller's
 * mistake (an unknown tool, bad params); internal and server-defined codes are
 * the server's trouble and worth retrying.
 */
function exitCodeForRpc(rpcCode: unknown): (typeof ExitCode)[keyof typeof ExitCode] {
  switch (rpcCode) {
    case -32700: // parse error
    case -32600: // invalid request
    case -32601: // method not found
    case -32602: // invalid params (includes an unknown tool name)
      return ExitCode.USAGE;
    default:
      return ExitCode.CONNECTION;
  }
}

/** A stateless server may answer with JSON or with a one-event SSE stream. */
async function readRpcBody(res: Response): Promise<any> {
  const text = await res.text();
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const data = text
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .filter(Boolean)
      .pop();
    return data ? JSON.parse(data) : undefined;
  }
  return text ? JSON.parse(text) : undefined;
}

/** A tool's payload: `structuredContent`, else the first text block as JSON (or raw text). */
function toolPayload(result: any): any {
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const text = Array.isArray(result?.content)
    ? result.content.find((c: any) => c?.type === 'text')?.text
    : undefined;
  if (typeof text !== 'string') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function callTool<T = any>(server: string, name: string, args: Record<string, unknown>): Promise<T> {
  const res = await authedFetch(server, '/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  // The per-user budget (40 calls / 10 s) answers 429 before any JSON-RPC.
  if (res.status === 429) {
    throw new PagesToolError(ExitCode.CONNECTION, `${name}: rate limited by ${server}; try again shortly.`, 'rate_limited', retryAfterMs(res));
  }
  let body: any;
  try {
    body = await readRpcBody(res);
  } catch {
    throw connectionError(`${server}/mcp returned an unreadable response (HTTP ${res.status}).`);
  }
  if (!res.ok && !body?.error) {
    throw connectionError(`${server}/mcp returned HTTP ${res.status}.`);
  }
  if (body?.error) {
    const rpcCode = body.error.code;
    throw new PagesToolError(
      exitCodeForRpc(rpcCode),
      `${name}: ${body.error.message ?? 'JSON-RPC error'}${typeof rpcCode === 'number' ? ` (JSON-RPC ${rpcCode})` : ''}`,
    );
  }
  const payload = toolPayload(body?.result);
  if (body?.result?.isError) {
    const code = typeof payload?.code === 'string' ? payload.code : undefined;
    const message = typeof payload === 'string' ? payload : payload?.message ?? 'tool error';
    const hint = code && STATUS_HINT_CODES.has(code) ? " Run 'nim wiki status'." : '';
    throw new PagesToolError(exitCodeForTool(code), `${name}: ${message}${code ? ` (${code})` : ''}${hint}`, code);
  }
  return payload as T;
}
