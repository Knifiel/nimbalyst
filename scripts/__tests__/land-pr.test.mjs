import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LANDING_FILE_MARGIN, LandingError, evaluatePreview, landPr, parseArgs } from '../land-pr.mjs';
import { LARGE_COMMIT_FILE_LIMIT } from '../commit-safety-policy.mjs';
import { FIXTURE_AUTHOR, assertInSandbox, commitFiles, makeGit, makeScratchRepo, sandboxEnv, writeFile } from './helpers/gitSandbox.mjs';

const PR_NUMBER = 7;

// A bare "GitHub" remote, a contributor clone that pushes a PR branch to
// refs/pull/7/head, and the maintainer's clone on main. `gh` is replaced by a
// record describing that branch, so the script runs against real git only.
function makeWorld(t, { prFiles = ['src/feature.ts', 'src/feature.test.ts'], prCommits = 1 } = {}) {
  const { repo: seed, git: seedGit } = makeScratchRepo(t, 'nim-land-pr-seed-');
  writeFile(seed, '.gitignore', 'nimbalyst-local/\n');
  writeFile(seed, 'CHANGELOG.md', '# Changelog\n\n## [Unreleased]\n\n- base entry\n');
  commitFiles(seed, seedGit, 'base', ['.gitignore', 'CHANGELOG.md', 'src/app.ts']);

  const origin = mkdtempSync(path.join(tmpdir(), 'nim-land-pr-origin-'));
  t.after(() => rmSync(origin, { recursive: true, force: true }));
  seedGit(['init', '-q', '--bare', '-b', 'main', origin]);
  seedGit(['push', '-q', origin, 'main']);

  const contributor = mkdtempSync(path.join(tmpdir(), 'nim-land-pr-contrib-'));
  t.after(() => rmSync(contributor, { recursive: true, force: true }));
  seedGit(['clone', '-q', origin, contributor]);
  const contribGit = makeGit(contributor);
  assertInSandbox(contributor, contribGit);
  contribGit(['checkout', '-q', '-b', 'feat/thing']);
  let prHead;
  for (let i = 0; i < prCommits; i += 1) {
    const files = i === 0 ? prFiles : [`src/extra${i}.ts`];
    prHead = commitFiles(contributor, contribGit, `feature ${i + 1}`, files);
  }
  contribGit(['push', '-q', 'origin', `HEAD:refs/pull/${PR_NUMBER}/head`]);

  const local = mkdtempSync(path.join(tmpdir(), 'nim-land-pr-local-'));
  t.after(() => rmSync(local, { recursive: true, force: true }));
  seedGit(['clone', '-q', origin, local]);
  const git = makeGit(local);
  assertInSandbox(local, git);
  const originMain = git(['rev-parse', 'origin/main']).trim();

  const pr = {
    number: PR_NUMBER, state: 'OPEN', isDraft: false, title: 'Add the thing',
    headRefOid: prHead, headRefName: 'feat/thing', headRepositoryOwner: { login: 'ada' },
    baseRefName: 'main', changedFiles: git(['diff', '--name-only', originMain, prHead], { env: sandboxEnv() }).trim().split('\n').length,
  };
  const logs = [];
  // The script commits the merge with its own git; a CI runner has no identity to infer, unlike a laptop.
  const identity = {
    GIT_AUTHOR_NAME: FIXTURE_AUTHOR.name, GIT_AUTHOR_EMAIL: FIXTURE_AUTHOR.email,
    GIT_COMMITTER_NAME: FIXTURE_AUTHOR.name, GIT_COMMITTER_EMAIL: FIXTURE_AUTHOR.email,
  };
  const land = (overrides = {}, flags = {}) => landPr({
    prNumber: PR_NUMBER, cwd: local, env: sandboxEnv(identity), gh: () => ({ ...pr, ...overrides }), log: (line) => logs.push(line), ...flags,
  });
  return { origin, originMain, contributor, contribGit, local, git, pr, prHead, land, logs };
}

function assertRemoteUntouched({ origin, originMain, prHead }) {
  const originGit = makeGit(origin);
  assert.equal(originGit(['rev-parse', 'main']).trim(), originMain, 'the script must never push main');
  assert.equal(originGit(['rev-parse', `refs/pull/${PR_NUMBER}/head`]).trim(), prHead, 'the script must never touch the PR ref');
}

test('parseArgs accepts a number or a PR URL and the flags', () => {
  assert.deepEqual(parseArgs(['42']), { prNumber: 42, dryRun: false, verify: false });
  assert.deepEqual(parseArgs(['https://github.com/nimbalyst/nimbalyst/pull/1591', '--dry-run']), { prNumber: 1591, dryRun: true, verify: false });
  assert.equal(parseArgs(['--verify']).prNumber, undefined);
});

test('evaluatePreview refuses forbidden paths and file counts beyond the PR plus the margin', () => {
  assert.equal(evaluatePreview({ previewPaths: ['a', 'b'], changedFiles: 2 }).ok, true);
  assert.equal(evaluatePreview({ previewPaths: Array.from({ length: 2 + LANDING_FILE_MARGIN }, (_, i) => `f${i}`), changedFiles: 2 }).ok, true);
  const over = evaluatePreview({ previewPaths: Array.from({ length: 3 + LANDING_FILE_MARGIN }, (_, i) => `f${i}`), changedFiles: 2 });
  assert.match(over.problems[0], /would touch 8 files but the PR changes 2/);
  assert.match(evaluatePreview({ previewPaths: ['nimbalyst-local/x.md'], changedFiles: 1 }).problems[0], /forbidden paths/);
  const huge = evaluatePreview({ previewPaths: Array.from({ length: LARGE_COMMIT_FILE_LIMIT + 1 }, (_, i) => `f${i}`), changedFiles: LARGE_COMMIT_FILE_LIMIT + 1 });
  assert.match(huge.problems[0], /commit-safety limit/);
});

test('lands a clean PR as a --no-ff merge on main and stops before push', (t) => {
  const world = makeWorld(t, { prCommits: 2 });
  const { git, originMain, prHead, land, logs } = world;
  const result = land();
  assert.equal(result.ok, true);
  assert.equal(result.previousTip, originMain);
  assert.equal(git(['symbolic-ref', '--short', 'HEAD']).trim(), 'main');
  assert.deepEqual(git(['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(' ').slice(1), [originMain, prHead]);
  assert.equal(git(['log', '-1', '--format=%s%n%b']).trim(), `Merge pull request #7 from ada/feat/thing\nAdd the thing`);
  assert.equal(result.fileCount, 3);
  assert.match(logs.at(-1), /Not pushing/);
  assertRemoteUntouched(world);

  // Running it again is a no-op, not a second merge.
  assert.equal(land().alreadyLanded, true);
  assert.equal(git(['rev-parse', 'HEAD']).trim(), result.mergeSha);
});

test('refuses when the merge would touch more files than the PR reports, and never leaves a merge behind', (t) => {
  const world = makeWorld(t, { prFiles: Array.from({ length: 10 }, (_, i) => `src/f${i}.ts`) });
  assert.throws(() => world.land({ changedFiles: 2 }), (error) => {
    assert.ok(error instanceof LandingError);
    assert.match(error.message, /would touch 10 files but the PR changes 2/);
    return true;
  });
  assert.equal(world.git(['rev-parse', 'HEAD']).trim(), world.originMain);
  assert.equal(existsSync(path.join(world.local, '.git', 'MERGE_HEAD')), false);
  assertRemoteUntouched(world);
});

test('refuses a PR that carries nimbalyst-local or contains a merge commit', (t) => {
  const world = makeWorld(t);
  const { contributor, contribGit, git } = world;

  // Contributor merges main into the branch (the 2026-10-10 shape) and force-adds a local file.
  commitFiles(contributor, contribGit, 'local leak', ['nimbalyst-local/notes.md'], { force: true });
  contribGit(['push', '-q', 'origin', `HEAD:refs/pull/${PR_NUMBER}/head`]);
  const leakHead = contribGit(['rev-parse', 'HEAD']).trim();
  assert.throws(() => world.land({ headRefOid: leakHead, changedFiles: 3 }), /forbidden paths: nimbalyst-local\/notes\.md/);

  contribGit(['checkout', '-q', 'main']);
  commitFiles(contributor, contribGit, 'main moved', ['src/other.ts']);
  contribGit(['push', '-q', 'origin', 'main']);
  contribGit(['checkout', '-q', 'feat/thing']);
  contribGit(['merge', '-q', '--no-ff', '--no-verify', '-m', 'Merge main into feat/thing', 'main']);
  contribGit(['push', '-q', 'origin', `HEAD:refs/pull/${PR_NUMBER}/head`]);
  const mergeHead = contribGit(['rev-parse', 'HEAD']).trim();
  assert.throws(() => world.land({ headRefOid: mergeHead, changedFiles: 4 }), /contains merge commits/);
  // Local main was fast-forwarded to the moved origin/main before the refusal; nothing else changed.
  assert.equal(git(['rev-parse', 'HEAD']).trim(), git(['rev-parse', 'origin/main']).trim());
  assert.equal(git(['log', '-1', '--format=%s']).trim(), 'main moved');
});

test('refuses a stale PR record, a non-main checkout, a non-main base, and a closed PR', (t) => {
  const world = makeWorld(t);
  assert.throws(() => world.land({ headRefOid: 'f'.repeat(40) }), /does not match GitHub's/);
  assert.throws(() => world.land({ baseRefName: 'release' }), /targets release, not main/);
  assert.throws(() => world.land({ state: 'MERGED' }), /is MERGED/);
  world.git(['checkout', '-q', '-b', 'scratch']);
  assert.throws(() => world.land(), /checkout is on 'scratch'/);
  world.git(['checkout', '-q', 'main']);
  assert.equal(world.land({}, { dryRun: true }).dryRun, true);
  assert.equal(world.git(['rev-parse', 'HEAD']).trim(), world.originMain);
  assertRemoteUntouched(world);
});

test('a conflict stops with instructions and --verify accepts the hand-finished merge', (t) => {
  const world = makeWorld(t, { prFiles: ['CHANGELOG.md', 'src/feature.ts'] });
  const { local, git, originMain, prHead } = world;
  // The contributor's CHANGELOG edit conflicts with one already on main.
  writeFileSync(path.join(world.contributor, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\n- contributor entry\n- base entry\n');
  const head = commitFiles(world.contributor, world.contribGit, 'changelog', ['CHANGELOG.md']);
  world.contribGit(['push', '-q', 'origin', `HEAD:refs/pull/${PR_NUMBER}/head`]);
  writeFileSync(path.join(local, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\n- maintainer entry\n- base entry\n');
  commitFiles(local, git, 'maintainer changelog', ['CHANGELOG.md']);
  const localTip = git(['rev-parse', 'HEAD']).trim();

  assert.throws(() => world.land({ headRefOid: head, changedFiles: 2 }), /merge conflicts in: CHANGELOG\.md[\s\S]*--verify/);
  assert.equal(git(['rev-parse', 'MERGE_HEAD']).trim(), head);
  writeFileSync(path.join(local, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\n- maintainer entry\n- contributor entry\n- base entry\n');
  git(['add', 'CHANGELOG.md']);
  git(['commit', '-q', '--no-edit']);

  const verified = world.land({ headRefOid: head, changedFiles: 2 }, { verify: true });
  assert.equal(verified.verified, true);
  assert.deepEqual(git(['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(' ').slice(1), [localTip, head]);
  assert.throws(() => world.land({ headRefOid: prHead, changedFiles: 2 }, { verify: true }), /HEAD\^2 is/);
  assertRemoteUntouched({ ...world, prHead: head });
  assert.notEqual(localTip, originMain);
});
