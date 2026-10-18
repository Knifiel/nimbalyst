/**
 * One log line per personal-sync socket close, replacing the error/close pair
 * that said nothing the close frame did not (and printed the room URL).
 *
 * Allowlist only. The URL names the room and carries the bearer token, and
 * free text from a close frame or an error event can carry anything a server
 * or proxy chose to put there (tokens, ids, titles). So the line holds the
 * numeric close code with a label from a fixed table, the LENGTH of any close
 * reason, an error classified into a fixed set of kinds, and reconnect
 * decisions this client produced itself. No received text is ever copied.
 */
export type SocketCloseNext =
  | { reconnectInMs: number }
  | { reconnect: 'on the next write or index reconnect' }
  | { notReconnecting: SocketNotReconnectingReason };

/** Every reason this client gives for not reconnecting; never received text. */
export type SocketNotReconnectingReason =
  | 'sync was shut down'
  | 'message sync disabled after a server rejection'
  | 'never opened; the pending connect() rejects to its caller'
  | 'session no longer wanted'
  | 'JWT/personal-member mismatch; waiting for an explicit reconnect';

export interface SocketCloseFacts {
  code?: number;
  reason?: string;
  wasClean?: boolean;
  /** Epoch ms at `onopen`; absent when the socket never opened. */
  openedAt?: number;
  closedAt: number;
  /** Message from an `error` event that preceded the close; only its kind is logged. */
  error?: string;
  next: SocketCloseNext;
}

const CLOSE_CODE_LABELS: Readonly<Record<number, string>> = {
  1000: 'normal', 1001: 'going away', 1002: 'protocol error', 1003: 'unsupported data',
  1005: 'no status', 1006: 'abnormal closure', 1007: 'invalid payload', 1008: 'policy violation',
  1009: 'message too big', 1011: 'server error', 1012: 'service restart', 1013: 'try again later',
  1015: 'TLS failure', 4002: 'removed from team', 4003: 'access revoked',
};

const NETWORK_ERROR_CODES = ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE'] as const;

function describeCode(code: number | undefined): string {
  if (code === undefined || !Number.isInteger(code)) return 'code=unknown';
  return `code=${code} (${CLOSE_CODE_LABELS[code] ?? 'unrecognized'})`;
}

/** A fixed kind for an error message: an HTTP status, a network error code, TLS, or `other`. */
export function classifySocketError(message: string): string {
  const status = /Unexpected server response:\s*([1-5]\d\d)\b/.exec(message);
  if (status) return `http-${status[1]}`;
  const network = NETWORK_ERROR_CODES.find(code => new RegExp(`\\b${code}\\b`).test(message));
  if (network) return network;
  if (/\b(?:certificate|TLS|SSL)\b/i.test(message)) return 'tls';
  return 'other';
}

export function describeSocketClose(subject: string, facts: SocketCloseFacts): string {
  const parts = [
    describeCode(facts.code),
    `reasonLength=${facts.reason?.length ?? 0}`,
    `wasClean=${facts.wasClean ?? 'unknown'}`,
    `reachedOpen=${facts.openedAt !== undefined}`,
  ];
  if (facts.openedAt !== undefined) parts.push(`openFor=${Math.max(0, facts.closedAt - facts.openedAt)}ms`);
  if (facts.error) {
    const kind = classifySocketError(facts.error);
    parts.push(kind === 'other' ? `error=other (length ${facts.error.length})` : `error=${kind}`);
  }
  const next = facts.next;
  if ('reconnectInMs' in next) parts.push(`reconnect in ${Math.round(next.reconnectInMs)}ms`);
  else if ('reconnect' in next) parts.push(`reconnect ${next.reconnect}`);
  else parts.push(`not reconnecting: ${next.notReconnecting}`);
  return `[CollabV3] ${subject}: ${parts.join(', ')}`;
}

/** The message an `error` event carries, when it carries one (Node's `ws` does; browsers do not). */
export function socketErrorMessage(event: Event): string | undefined {
  if (typeof ErrorEvent !== 'undefined' && event instanceof ErrorEvent) return event.message || undefined;
  const message = (event as { message?: unknown }).message;
  return typeof message === 'string' && message ? message : undefined;
}
