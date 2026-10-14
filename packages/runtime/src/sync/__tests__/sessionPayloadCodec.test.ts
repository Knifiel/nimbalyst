// @vitest-environment node
import { expect, it } from 'vitest';
import { encodeSessionPayload, decodeSessionPayload } from '../sessionPayloadCodec';
import { MAX_SESSION_INLINE_BYTES } from '@nimbalyst/collab-protocol';

it('round-trips escaped multibyte content through independently authenticated bounded parts', async () => {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  for (const content of ['small', JSON.stringify({ content: '\u0000漢字🙂'.repeat(60000) })]) {
    const encoded = await encodeSessionPayload('stable-id', content, key);
    expect(encoded.encryptedContent.length).toBeLessThanOrEqual(MAX_SESSION_INLINE_BYTES);
    for (const part of encoded.parts) expect(part.encryptedContent.length).toBeLessThanOrEqual(MAX_SESSION_INLINE_BYTES);
    expect(await decodeSessionPayload({ id: 'stable-id', ...encoded }, key, [...encoded.parts].reverse())).toBe(content);
    if (encoded.parts.length) {
      await expect(decodeSessionPayload({ id: 'stable-id', ...encoded }, key, encoded.parts.slice(1))).rejects.toThrow();
      await expect(decodeSessionPayload({ id: 'other-id', ...encoded }, key, encoded.parts)).rejects.toThrow();
      const corrupt = encoded.parts.map((part, index) => index === 0 ? { ...part, encryptedContent: `AAAA${part.encryptedContent.slice(4)}` } : part);
      await expect(decodeSessionPayload({ id: 'stable-id', ...encoded }, key, corrupt)).rejects.toThrow();
      const mixed = [encoded.parts[1], ...encoded.parts.slice(1)];
      await expect(decodeSessionPayload({ id: 'stable-id', ...encoded }, key, mixed)).rejects.toThrow();
    }
  }
});

it('decodes the same encrypted form fixture as Swift and Kotlin', async () => {
  const { readFileSync } = await import('node:fs');
  const fixture = JSON.parse(readFileSync(new URL('../../../../collab-protocol/fixtures/payload/encrypted-form.json', import.meta.url), 'utf8'));
  const key = await crypto.subtle.importKey('raw', Buffer.from(fixture.key, 'base64'), 'AES-GCM', false, ['decrypt']);
  expect(await decodeSessionPayload(fixture.entry, key, fixture.parts)).toBe(fixture.content);
});

it('switches to parts at the exact encrypted base64 row boundary', async () => {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const maxPlaintext = MAX_SESSION_INLINE_BYTES / 4 * 3 - 16; // AES-GCM tag, then base64
  const inline = await encodeSessionPayload('boundary', 'x'.repeat(maxPlaintext), key);
  expect(inline.encryptedContent.length).toBe(MAX_SESSION_INLINE_BYTES);
  expect(inline.payload).toBeUndefined();
  const content = 'x'.repeat(maxPlaintext + 1);
  const overflow = await encodeSessionPayload('boundary', content, key);
  expect(overflow.parts.length).toBeGreaterThan(0);
  expect(await decodeSessionPayload({ id: 'boundary', ...overflow }, key, overflow.parts)).toBe(content);
});
