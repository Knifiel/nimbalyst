/**
 * Reuses the ciphertext of an unchanged plaintext.
 *
 * The collab server cannot read personal-sync payloads, so the only way it can
 * tell that an index row did not change is byte equality. A fresh random IV on
 * every publish made every re-sent title, client-metadata blob, and queued
 * prompt look new, and each one cost the server a row rewrite plus a
 * replication-journal entry (about 11 billed rows per index update).
 *
 * Reusing an IV is only unsafe in AES-GCM for different plaintexts under the
 * same key. This cache returns a previous (ciphertext, IV) pair only for the
 * exact same plaintext in the same scope; anything else gets a fresh IV. The
 * server learns that a field is unchanged, which it could already infer from
 * an update arriving with no visible effect. Scopes are per session and field,
 * so two sessions with the same title still produce different ciphertext.
 */

import { encrypt } from './collabV3Crypto';

const MAX_ENTRIES = 4096;

type Sealed = { encrypted: string; iv: string };

let caches = new WeakMap<CryptoKey, Map<string, { content: string; sealed: Sealed }>>();

/** Tests that exercise the encryption await windows need every field to miss. */
export function clearStableCiphertextCache(): void {
  caches = new WeakMap();
}

export async function encryptStable(scope: string, content: string, key: CryptoKey): Promise<Sealed> {
  let cache = caches.get(key);
  if (!cache) {
    cache = new Map();
    caches.set(key, cache);
  }
  const hit = cache.get(scope);
  if (hit && hit.content === content) {
    // Refresh recency so active sessions stay cached.
    cache.delete(scope);
    cache.set(scope, hit);
    return hit.sealed;
  }
  const sealed = await encrypt(content, key);
  cache.delete(scope);
  cache.set(scope, { content, sealed });
  if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  return sealed;
}
