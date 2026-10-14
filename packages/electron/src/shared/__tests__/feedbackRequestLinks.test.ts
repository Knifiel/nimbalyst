// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { parseConsoleFeedbackRequestLink } from '@nimbalyst/collab-protocol';

import { CONSOLE_ORIGIN } from '../consoleOrigin';
import {
  buildFeedbackRequestDeepLink,
  feedbackRequestConsoleUrl,
  parseFeedbackRequestDeepLink,
} from '../feedbackRequestLinks';
import { resolveOrgMessagingDestination } from '../orgMessagingRouting';

/**
 * The pasteable link is the delivery mechanism for this whole feature: a
 * recipient without the desktop app is notified through no other channel. So
 * what is pinned here is that the URL is addressed from the configured console
 * origin rather than a literal at a call site, that its path is the shape the
 * console actually routes, and that the app-scheme half round-trips.
 */
describe('feedback request links', () => {
  it('routes the project org to its mode and every other org to the window', () => {
    expect(resolveOrgMessagingDestination('org-project', 'org-project')).toBe('project-mode');
    expect(resolveOrgMessagingDestination('org-project', 'org-other')).toBe('org-window');
    expect(resolveOrgMessagingDestination(null, 'org-other')).toBe('org-window');
    // Both sides absent is the shape that reaches this from an IPC or API
    // boundary, where the types are not enforced. A missing target is not the
    // project's own org, so it must not be handed the project's mode.
    expect(resolveOrgMessagingDestination(null, null)).toBe('org-window');
    expect(resolveOrgMessagingDestination(undefined, undefined)).toBe('org-window');
    expect(resolveOrgMessagingDestination('org-project', null)).toBe('org-window');
  });

  it('builds the console URL from the configured origin', () => {
    const url = feedbackRequestConsoleUrl('org-a', 'request-1');

    expect(url.startsWith(`${CONSOLE_ORIGIN}/`)).toBe(true);
    // Matches `orgFeedbackRequestPath` / `consoleRoutePatterns.feedbackRequest`
    // in the collab repo's web-console routing, which cannot be imported here.
    expect(new URL(url).pathname).toBe('/org/org-a/feedback/request-1');
    // An origin can be handed in, so a caller with a configured one is never
    // forced through the default.
    expect(feedbackRequestConsoleUrl('org-a', 'request-1', 'https://example.test'))
      .toBe('https://example.test/org/org-a/feedback/request-1');
  });

  it('is the console link shape the desktop routes back into the Inbox', () => {
    expect(parseConsoleFeedbackRequestLink(feedbackRequestConsoleUrl('org-a', 'request (1)')))
      .toEqual({ orgRouteKey: 'org-a', requestId: 'request (1)' });
  });

  it('escapes ids rather than letting them alter the path', () => {
    const url = new URL(feedbackRequestConsoleUrl('org/a', 'req?x=1#y'));

    expect(url.pathname).toBe('/org/org%2Fa/feedback/req%3Fx%3D1%23y');
    expect(url.search).toBe('');
    expect(url.hash).toBe('');
  });

  it('round-trips the app deep link, ids needing escapes included', () => {
    const link = buildFeedbackRequestDeepLink('org-a', 'request 1/2');

    expect(parseFeedbackRequestDeepLink(link)).toEqual({
      orgId: 'org-a',
      requestId: 'request 1/2',
    });
  });

  it('rejects anything that is not a complete feedback-request link', () => {
    // Another scheme, another host, and a missing orgId all have to fall
    // through: main routes deep links by trying each shape in turn, and the
    // service target cannot be built without an org.
    expect(parseFeedbackRequestDeepLink('https://console.nimbalyst.com/org/a/feedback/r'))
      .toBeNull();
    expect(parseFeedbackRequestDeepLink('nimbalyst://tracker/t-1?orgId=org-a')).toBeNull();
    expect(parseFeedbackRequestDeepLink('nimbalyst://feedback-request/request-1')).toBeNull();
    expect(parseFeedbackRequestDeepLink('nimbalyst://feedback-request/?orgId=org-a')).toBeNull();
    expect(parseFeedbackRequestDeepLink('not a url')).toBeNull();
  });
});
