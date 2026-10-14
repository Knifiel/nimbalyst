/**
 * A deep link main could not route, said to the user instead of dropped.
 *
 * Main queues every notice and nudges one window; whichever renderer drains the
 * queue first shows it. That covers a cold start (the window is still mounting
 * when the link is handled) and an app with only the Project Manager open.
 */

export type DeepLinkNoticeReason = 'not-authenticated' | 'no-workspace';

export type DeepLinkNotice =
  | { kind: 'shared-document'; reason: DeepLinkNoticeReason; orgId: string; documentId: string }
  | { kind: 'shared-folder'; reason: DeepLinkNoticeReason; orgId: string; folderId: string }
  | { kind: 'feedback-request'; reason: DeepLinkNoticeReason; orgId: string; requestId: string };

/** Bare nudge: the notices themselves are only read through the consume channel. */
export const DEEP_LINK_NOTICE_AVAILABLE_CHANNEL = 'deep-link:notice-available';
export const DEEP_LINK_CONSUME_NOTICES_CHANNEL = 'deep-link:consume-notices';
