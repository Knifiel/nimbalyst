/**
 * The two ways to hand somebody a feedback request.
 *
 * A request addressed to someone who is not holding a live desktop socket
 * reaches them through no channel at all — there is no transactional mail on
 * the server and team deliveries are not wired to push. The author's copied
 * link *is* the delivery mechanism, so both forms are minted here rather than
 * assembled at the surfaces that offer them:
 *
 * - `feedbackRequestConsoleUrl` works for anyone with an org membership and a
 *   browser. It is the one to paste into a chat.
 * - `buildFeedbackRequestDeepLink` is for someone who already has the app; it
 *   lands on the request's row in the organization window's Inbox, where the
 *   respond card lives.
 *
 * The console path mirrors `orgFeedbackRequestPath` in the collab repo's
 * `web-console/src/routing.ts`. The two packages cannot import each other, so a
 * change to the console's route shape has to land on both sides.
 */

import { buildConsoleFeedbackRequestLink } from '@nimbalyst/collab-protocol';

import { CONSOLE_ORIGIN } from './consoleOrigin';

export interface FeedbackRequestDeepLink {
  orgId: string;
  requestId: string;
}

/** The deep link's `nimbalyst://<host>`; also the branch key in main. */
export const FEEDBACK_REQUEST_DEEP_LINK_HOST = 'feedback-request';

/**
 * The pasteable link.
 *
 * `orgRouteKey` is the console's org route segment: its slug when the server
 * has one, and the org id otherwise. The desktop app only ever holds the id,
 * and `findTeamByRouteKey` in the console matches on either, so an id-keyed
 * link resolves for a recipient whose org later gains a slug.
 */
export function feedbackRequestConsoleUrl(
  orgRouteKey: string,
  requestId: string,
  origin: string = CONSOLE_ORIGIN,
): string {
  // One builder, so the desktop reads back (`parseConsoleFeedbackRequestLink`)
  // exactly what it hands out.
  return buildConsoleFeedbackRequestLink(orgRouteKey, requestId, origin);
}

export function buildFeedbackRequestDeepLink(
  orgId: string,
  requestId: string,
): string {
  const url = new URL(
    `nimbalyst://${FEEDBACK_REQUEST_DEEP_LINK_HOST}/${encodeURIComponent(requestId)}`,
  );
  url.searchParams.set('orgId', orgId);
  return url.toString();
}

/** Null rather than a throw: main routes deep links by trying each shape. */
export function parseFeedbackRequestDeepLink(
  rawUrl: string,
): FeedbackRequestDeepLink | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== 'nimbalyst:'
    || parsed.host !== FEEDBACK_REQUEST_DEEP_LINK_HOST
  ) {
    return null;
  }
  const orgId = parsed.searchParams.get('orgId');
  const [segment] = parsed.pathname.split('/').filter(Boolean);
  if (!orgId || !segment) return null;
  try {
    return { orgId, requestId: decodeURIComponent(segment) };
  } catch {
    // A malformed percent-escape is not a request id.
    return null;
  }
}
