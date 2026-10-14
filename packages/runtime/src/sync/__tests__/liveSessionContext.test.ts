// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { decrypt } from '../collabV3Crypto';
import { createLiveContextPublisher } from '../liveSessionContext';
import type { CachedSessionIndex } from '../sessionIndexMetadata';

describe('createLiveContextPublisher', () => {
  it('relays context without a stored write, keeps it for the turn-end write, and falls back for unknown sessions', async () => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const cache = new Map<string, CachedSessionIndex>([['known', { sessionId: 'known', title: 't' } as CachedSessionIndex]]);
    const sent: string[] = [];
    let socketOpen = true;
    const fallback = vi.fn(async () => ({ published: true }));
    const { publish, overlay } = createLiveContextPublisher({
      serialize: (_id, task) => task(),
      getCached: (id) => cache.get(id),
      setCached: (id, entry) => { cache.set(id, entry); },
      encryptionKey: () => key,
      send: (frame) => socketOpen && (sent.push(frame), true),
      fallback,
      now: () => 42,
    });

    await expect(publish('known', { tokens: 1200, contextWindow: 200000 })).resolves.toEqual({ published: true });
    const frame = JSON.parse(sent[0]);
    expect(frame).toMatchObject({ type: 'sessionContextUpdate', update: { sessionId: 'known', at: 42 } });
    expect(JSON.parse(await decrypt(frame.update.encryptedContext, frame.update.contextIv, key)))
      .toEqual({ currentContext: { tokens: 1200, contextWindow: 200000 } });
    expect(cache.get('known')?.currentContext).toEqual({ tokens: 1200, contextWindow: 200000 });
    expect(fallback).not.toHaveBeenCalled();
    // The latest value survives the cache entry being replaced by an older stored row.
    expect(overlay({ sessionId: 'known', currentContext: { tokens: 100, contextWindow: 200000 } }).currentContext?.tokens).toBe(1200);

    // With the socket down the value is still merged for the next index write.
    socketOpen = false;
    await expect(publish('known', { tokens: 1500, contextWindow: 200000 })).resolves.toMatchObject({ published: false, retryable: true });
    expect(cache.get('known')?.currentContext?.tokens).toBe(1500);

    await publish('new-session', { tokens: 1, contextWindow: 2 });
    expect(fallback).toHaveBeenCalledWith('new-session', { tokens: 1, contextWindow: 2 });
  });
});
