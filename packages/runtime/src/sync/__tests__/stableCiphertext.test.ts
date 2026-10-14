// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { decrypt } from '../collabV3Crypto';
import { encryptStable } from '../stableCiphertext';

const newKey = () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);

describe('encryptStable', () => {
  it('repeats ciphertext only for the same plaintext in the same scope and key', async () => {
    const key = await newKey();
    const first = await encryptStable('title:s1', 'Fix sync', key);
    expect(await encryptStable('title:s1', 'Fix sync', key)).toEqual(first);
    // A changed value, another session, or a rotated key never reuses the IV.
    const changed = await encryptStable('title:s1', 'Fix sync costs', key);
    const otherSession = await encryptStable('title:s2', 'Fix sync', key);
    const rotated = await encryptStable('title:s1', 'Fix sync', await newKey());
    expect(new Set([first.iv, changed.iv, otherSession.iv, rotated.iv]).size).toBe(4);
    expect(await decrypt(changed.encrypted, changed.iv, key)).toBe('Fix sync costs');
    // Changing back is a new encryption, not the stale first entry.
    expect((await encryptStable('title:s1', 'Fix sync', key)).iv).not.toBe(first.iv);
  });
});
