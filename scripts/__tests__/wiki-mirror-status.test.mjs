// The release decision behind /ship for the nimbalyst-wiki mirror. Installs
// update by plugin version, so a changed plugin under an unchanged version must
// read as needing a bump, never as ready to stage.
import assert from 'node:assert/strict';
import test from 'node:test';
import { decide, parseSource } from '../wiki-mirror-status.mjs';

test('the mirror stages only on a new version, and never with mismatched or older versions', () => {
  assert.equal(decide({ localVersions: ['0.5.0', '0.5.0'], mirrorVersion: '0.5.0', changed: false }).status, 'up to date');
  assert.equal(decide({ localVersions: ['0.5.0', '0.5.0'], mirrorVersion: '0.5.0', changed: true }).status, 'bump+stage');
  assert.equal(decide({ localVersions: ['0.6.0', '0.6.0'], mirrorVersion: '0.5.0', changed: true }).status, 'stage (already bumped)');
  assert.equal(decide({ localVersions: ['0.10.0', '0.10.0'], mirrorVersion: '0.9.0', changed: false }).status, 'stage (already bumped)');
  assert.equal(decide({ localVersions: ['0.4.0', '0.4.0'], mirrorVersion: '0.5.0', changed: true }).status, 'LOCAL BEHIND MIRROR');
  assert.equal(decide({ localVersions: ['0.6.0', '0.5.0'], mirrorVersion: '0.5.0', changed: true }).status, 'VERSIONS DIFFER');
  assert.equal(decide({ localVersions: ['0.5.0', '0.5.0'], mirrorVersion: null, changed: true }).status, 'never staged');
});

test('the baseline comes from the SOURCE line stage-wiki-repo.mjs writes', () => {
  const sha = '3fb117776cf0fcfc3501f8b45865e8b0f14151a5';
  assert.deepEqual(parseSource(`Staged from https://github.com/nimbalyst/nimbalyst at ${sha}\n`), { sha, dirty: false });
  assert.deepEqual(parseSource(`Staged from https://github.com/nimbalyst/nimbalyst at ${sha} (with uncommitted changes)\n`), { sha, dirty: true });
  assert.equal(parseSource(null), null);
  assert.equal(parseSource('hand-edited'), null);
});
