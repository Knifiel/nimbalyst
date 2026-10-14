// @vitest-environment node
/**
 * The production kill-switch path, end to end from PostHog to the decision.
 *
 * `rolloutAuthorization.test.ts` proves the evaluation rules. This file proves
 * the one thing evaluation cannot see: that **the on-disk cache is never an
 * input**. Every case here starts from an install carrying a cached, enabled,
 * unexpired snapshot -- the exact state that used to authorize a migration
 * forever -- and asserts it authorizes nothing on its own.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const analytics = {
  canEvaluateRemoteConfig: vi.fn(() => true),
  getFeatureFlagPayload: vi.fn(async () => null as unknown),
};

// Narrow module mocks: the two things `migrationFlag` reaches into. Neither
// pulls in the runtime barrel, and `AnalyticsService` builds a real
// electron-store singleton at import time, which a node test has no business
// constructing.
vi.mock('../../../services/analytics/AnalyticsService', () => ({
  AnalyticsService: { getInstance: () => analytics },
}));
vi.mock('../../../utils/store', () => ({
  getReleaseChannel: () => 'alpha',
}));
vi.mock('../../../utils/logger', () => ({
  logger: { main: { info: () => {}, warn: () => {}, error: () => {} } },
}));

import {
  authorizeRollout,
  cacheRolloutSnapshot,
  readCachedRolloutSnapshot,
  selectRolloutConfigSource,
  TEST_ROLLOUT_PAYLOAD_ENV,
} from '../migrationFlag';
import { readBackendState, writeBackendState } from '../BackendSelector';
import type { RolloutSnapshot } from '../rolloutAuthorization';

let tmp: string;

/** Deliberately far-future, so nothing here passes merely by expiring. */
function cachedEnable(): RolloutSnapshot {
  return {
    enabled: true,
    maxSourceBytes: 268435456, // 256 MiB
    releaseChannel: 'alpha',
    configVersion: 'sqlite-ramp-1',
    fetchedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-rollout-flag-'));
  writeBackendState(tmp, {
    backend: 'pglite',
    setAt: new Date().toISOString(),
    setBy: 'auto-migration-deferred',
    rolloutSnapshot: cachedEnable(),
  });
  analytics.canEvaluateRemoteConfig.mockReturnValue(true);
  analytics.getFeatureFlagPayload.mockResolvedValue(null);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('authorizeRollout', () => {
  it('does not authorize from the cache when the install is offline', async () => {
    // The whole point. Before this, a cached `true` migrated the install on
    // every launch forever; turning the flag off stopped new exposures only.
    analytics.getFeatureFlagPayload.mockRejectedValue(new Error('ENOTFOUND'));

    const result = await authorizeRollout(tmp);

    expect(result).toEqual({ authorized: false, reason: 'authorization_unavailable' });
    // The cache survives -- it is for Settings, and a failed launch must not
    // erase what the install was last told.
    expect(readCachedRolloutSnapshot(tmp)?.enabled).toBe(true);
  });

  it('does not authorize from the cache when the user has opted out of analytics', async () => {
    // An install we cannot subsequently stop is not offered an automatic
    // migration. See the file header of `migrationFlag.ts` for why this is the
    // chosen answer rather than a second, consent-independent fetch.
    analytics.canEvaluateRemoteConfig.mockReturnValue(false);

    const result = await authorizeRollout(tmp);

    expect(result).toEqual({ authorized: false, reason: 'authorization_unavailable' });
    expect(analytics.getFeatureFlagPayload).not.toHaveBeenCalled();
  });

  it('fails closed on a remote disable that arrives after a cached enable', async () => {
    // Only the fail-closed part is assertable here. While the shipped
    // allowlist is empty the version check fires first, so this build reports
    // `unsupported_config_version` rather than `rollout_disabled` -- both
    // decline, and the label only becomes distinguishable once a ramp
    // allowlists a version. `rolloutAuthorization.test.ts` pins the label
    // against an injected allowlist, which is where the verifier's
    // kill-switch exercise reads it from.
    analytics.getFeatureFlagPayload.mockResolvedValue({ ...cachedEnable(), enabled: false });

    const result = await authorizeRollout(tmp);

    expect(result.authorized).toBe(false);
  });

  it('rejects a payload aimed at the other channel', async () => {
    analytics.getFeatureFlagPayload.mockResolvedValue({
      ...cachedEnable(),
      releaseChannel: 'stable',
    });

    const result = await authorizeRollout(tmp);

    expect(result).toMatchObject({ authorized: false, reason: 'channel_mismatch' });
  });

  it('rejects a payload this build has no configuration version for', async () => {
    // A later cohort's version is inert until a build accepts it, even when
    // every other field of the live payload is perfect.
    analytics.getFeatureFlagPayload.mockResolvedValue({ ...cachedEnable(), configVersion: 'sqlite-ramp-2' });

    const result = await authorizeRollout(tmp);

    expect(result).toMatchObject({ authorized: false, reason: 'unsupported_config_version' });
  });
});

describe('the Playwright payload file', () => {
  it('is ignored unless PLAYWRIGHT=1, so the path variable alone cannot authorize a migration', async () => {
    const file = path.join(tmp, 'rollout-payloads.json');
    fs.writeFileSync(file, JSON.stringify({ 'sqlite-rollout-alpha': cachedEnable() }));
    analytics.getFeatureFlagPayload.mockResolvedValue(null);

    const withoutPlaywright = selectRolloutConfigSource({ [TEST_ROLLOUT_PAYLOAD_ENV]: file });
    expect(await withoutPlaywright.fetchPayload('sqlite-rollout-alpha')).toBeNull();

    const underPlaywright = selectRolloutConfigSource({ PLAYWRIGHT: '1', [TEST_ROLLOUT_PAYLOAD_ENV]: file });
    expect(await underPlaywright.fetchPayload('sqlite-rollout-alpha')).toMatchObject({ configVersion: 'sqlite-ramp-1' });
    expect(await underPlaywright.fetchPayload('sqlite-rollout-stable')).toBeNull();
  });
});

describe('the rollout snapshot cache', () => {
  it('round-trips without disturbing the backend the install resolved to', () => {
    // The cache lives in the same file as the backend selection, and a write
    // that clobbered `backend` is exactly how #1347 pinned installs to a
    // database they should never have had.
    cacheRolloutSnapshot(tmp, { ...cachedEnable(), configVersion: 'sqlite-ramp-2' });

    expect(readCachedRolloutSnapshot(tmp)?.configVersion).toBe('sqlite-ramp-2');
    expect(readBackendState(tmp)?.backend).toBe('pglite');
    expect(readBackendState(tmp)?.setBy).toBe('auto-migration-deferred');
  });
});
