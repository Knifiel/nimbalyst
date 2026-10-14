/**
 * The SDK's `rate_limit_event`, reduced to what the transcript card and the
 * auto-resume scheduler need.
 *
 * A blocked turn arrives as a `rate_limit_event` followed by a `result` error
 * whose text ("You've hit your session limit · resets 11:40am (TZ)") is
 * localized and not worth parsing. The event carries the reset as a timestamp,
 * so the provider records it here and attaches it to the terminal error.
 */

export interface RateLimitInfo {
  status?: string;
  resetsAt?: number | null;
  rateLimitType?: string;
  utilization?: number | null;
}

export interface BlockingUsageLimit {
  /** Epoch ms, or null when the SDK did not say. */
  resetsAtMs: number | null;
  /** The SDK's raw type, e.g. `five_hour`. */
  limitType: string;
}

/** A limit that stops the turn. `allowed_warning` only warns. */
export function blockingUsageLimit(info: RateLimitInfo | undefined): BlockingUsageLimit | null {
  if (!info || info.status === 'allowed' || info.status === 'allowed_warning') return null;
  return {
    resetsAtMs: info.resetsAt ? info.resetsAt * 1000 : null,
    limitType: info.rateLimitType || 'unknown',
  };
}

/** `<!-- [RATE_LIMIT] ... -->`, the marker `RateLimitWidget` parses. */
export function rateLimitMarker(info: RateLimitInfo, model: string | undefined): string {
  const limitType = info.rateLimitType === 'five_hour' ? '5-hour session' : info.rateLimitType || 'unknown';
  const marker = info.status === 'allowed_warning' ? '[RATE_LIMIT_WARNING]' : '[RATE_LIMIT]';
  const utilization = info.utilization != null ? ` usage=${Math.round(info.utilization * 100)}` : '';
  const modelStr = model ? ` model=${model}` : '';
  return `<!-- ${marker} limitType=${limitType} resetsAtUnix=${info.resetsAt || 'unknown'}${utilization}${modelStr} -->`;
}

/**
 * The saved transcript row for a blocked turn: the marker so the desktop
 * renders the card, then the SDK's own sentence for surfaces that do not.
 */
export function usageLimitSystemMessage(limit: BlockingUsageLimit, errorMessage: string, model: string | undefined): string {
  const marker = rateLimitMarker(
    {
      status: 'rejected',
      resetsAt: limit.resetsAtMs != null ? Math.round(limit.resetsAtMs / 1000) : null,
      rateLimitType: limit.limitType,
    },
    model,
  );
  return `${marker}\n\n${errorMessage}`;
}
