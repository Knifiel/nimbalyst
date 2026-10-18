// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WikiChangeFeed, type WikiFeedEvent } from '../client';

class FakeEventSource {
  static last: FakeEventSource | null = null;
  onerror: (() => void) | null = null;
  private readonly handlers = new Map<string, () => void>();
  constructor() {
    FakeEventSource.last = this;
  }
  addEventListener(type: string, handler: () => void): void {
    this.handlers.set(type, handler);
  }
  fire(type: string): void {
    this.handlers.get(type)?.();
  }
  close(): void {}
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeEventSource.last = null;
});

describe('WikiChangeFeed', () => {
  it('is unreachable from a stream error until the server says ready again', () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const feed = new WikiChangeFeed();
    const seen: WikiFeedEvent['type'][] = [];
    feed.subscribe((event) => seen.push(event.type));
    const source = FakeEventSource.last!;

    source.fire('ready');
    expect(feed.isReachable()).toBe(true);
    // The agent session ended and took the server with it; the browser keeps retrying.
    source.onerror!();
    source.onerror!();
    expect(feed.isReachable()).toBe(false);
    source.fire('ready');
    expect(feed.isReachable()).toBe(true);
    expect(seen).toEqual(['ready', 'down', 'down', 'ready']);
  });
});
