// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { CollabHydrationWatch } from '../collabHydrationWatch';

describe('CollabHydrationWatch', () => {
  it('keeps loading through one dropped attempt, then reports the server unreachable', () => {
    const watch = new CollabHydrationWatch();
    expect(watch.observe('connecting', null)).toBeNull();
    expect(watch.observe('disconnected', null)).toBeNull();
    // Backoff ticks without a new attempt are not failures.
    expect(watch.observe('disconnected', null)).toBeNull();
    expect(watch.observe('connecting', null)).toBeNull();
    expect(watch.observe('disconnected', null)).toEqual({
      kind: 'unreachable',
      message: 'Could not reach the collaboration server.',
    });
  });

  it('fails at once when the room refuses the member', () => {
    const watch = new CollabHydrationWatch();
    watch.observe('connecting', null);
    expect(watch.observe('disconnected', 403)).toMatchObject({ kind: 'no-access' });
  });

  it('never fails a page that has loaded, and counts again after Retry', () => {
    const loaded = new CollabHydrationWatch();
    loaded.observe('connecting', null);
    loaded.observe('connected', null);
    loaded.observe('connecting', null);
    expect(loaded.observe('disconnected', 403)).toBeNull();

    const retried = new CollabHydrationWatch();
    retried.observe('connecting', null);
    retried.observe('disconnected', null);
    retried.reset();
    retried.observe('connecting', null);
    expect(retried.observe('disconnected', null)).toBeNull();
  });
});
