import assert from 'node:assert/strict';
import test from 'node:test';
import { checkPushDestination, parsePushRefs } from '../check-push-destination.mjs';

const MAINTAINER = {
  urlPattern: 'github\\.com[:/]nimbalyst/nimbalyst(\\.git)?$',
  refs: 'refs/heads/main,refs/tags/*',
};
const SHA = 'a'.repeat(40);
const line = (remoteRef) => `refs/heads/x ${SHA} ${remoteRef} ${'0'.repeat(40)}`;

test('no allowlist configured: contributors push anywhere', () => {
  const result = checkPushDestination({
    url: 'git@github.com:someone/nimbalyst.git',
    refs: parsePushRefs(line('refs/heads/feature')),
    config: {},
  });
  assert.equal(result.ok, true);
});

test('maintainer allowlist: main and release tags on origin pass', () => {
  const result = checkPushDestination({
    url: 'git@github.com:nimbalyst/nimbalyst.git',
    refs: parsePushRefs([line('refs/heads/main'), line('refs/tags/v0.80.7')].join('\n')),
    config: MAINTAINER,
  });
  assert.equal(result.ok, true);
});

test("maintainer allowlist: a contributor's fork is refused", () => {
  // The 2026-10-10 landing pushed an integration merge to a contributor's PR branch.
  const result = checkPushDestination({
    url: 'https://github.com/Sergio-3/nimbalyst.git',
    refs: parsePushRefs(line('refs/heads/pr/task-panel-kinds')),
    config: MAINTAINER,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /Sergio-3/);
});

test('maintainer allowlist: another branch on origin is refused', () => {
  const result = checkPushDestination({
    url: 'git@github.com:nimbalyst/nimbalyst.git',
    refs: parsePushRefs(line('refs/heads/landing/pr-1589')),
    config: MAINTAINER,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /refs\/heads\/landing\/pr-1589/);
});

test('override env lets a deliberate push through', () => {
  const result = checkPushDestination({
    url: 'https://github.com/Sergio-3/nimbalyst.git',
    refs: parsePushRefs(line('refs/heads/pr/task-panel-kinds')),
    config: MAINTAINER,
    override: true,
  });
  assert.equal(result.ok, true);
});
