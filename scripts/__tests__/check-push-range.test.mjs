import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { evaluateCommits, parseRevListParents } from '../check-push-range.mjs';
import { LARGE_COMMIT_FILE_LIMIT, SIZE_LIMIT_CONFIG_KEY } from '../commit-safety-policy.mjs';
import { assertInSandbox, commitFiles, makeScratchRepo, sandboxEnv, writeFile } from './helpers/gitSandbox.mjs';

const CHECK_SCRIPT = fileURLToPath(new URL('../check-push-range.mjs', import.meta.url));
const PRE_PUSH = fileURLToPath(new URL('../../.githooks/pre-push', import.meta.url));

function runCheck(repo, range, extraEnv = {}) {
  return execFileSync(process.execPath, [CHECK_SCRIPT, range], { cwd: repo, encoding: 'utf8', env: sandboxEnv(extraEnv) });
}

function expectRefusal(fn, pattern) {
  assert.throws(fn, (error) => {
    assert.equal(error.status, 1);
    assert.match(error.stderr, pattern);
    return true;
  });
}

test('evaluateCommits applies the policy per commit against the first parent', () => {
  const many = Array.from({ length: LARGE_COMMIT_FILE_LIMIT + 1 }, (_, i) => `f${i}.ts`);
  const commits = [
    { sha: 'a'.repeat(40), parents: ['1'], paths: ['src/ok.ts'] },
    { sha: 'b'.repeat(40), parents: ['1'], paths: ['nimbalyst-local/x.md', 'src/ok.ts'] },
    { sha: 'c'.repeat(40), parents: ['1', '2'], paths: many },
    { sha: 'd'.repeat(40), parents: ['1', '2', '3'], paths: ['x'] },
  ];
  const problems = evaluateCommits(commits, {});
  assert.deepEqual(problems.map(({ sha, kind }) => [sha[0], kind]), [['b', 'forbidden'], ['c', 'size'], ['d', 'parents']]);
  assert.deepEqual(evaluateCommits(commits, { NIMBALYST_LARGE_COMMIT: '1' }).map(({ kind }) => kind), ['forbidden', 'parents']);
  assert.deepEqual(evaluateCommits(commits, {}, false).map(({ kind }) => kind), ['forbidden', 'parents']);
  assert.deepEqual(parseRevListParents('aaa bbb ccc\nddd\n'), [{ sha: 'aaa', parents: ['bbb', 'ccc'] }, { sha: 'ddd', parents: [] }]);
});

test('CLI refuses a range whose commits leak local files or exceed the limit, including inside a merge', (t) => {
  const { repo, git } = makeScratchRepo(t, 'nim-push-range-');
  writeFile(repo, '.gitignore', 'nimbalyst-local/\n');
  const base = commitFiles(repo, git, 'base', ['.gitignore', 'src/app.ts']);
  const clean = commitFiles(repo, git, 'clean work', ['src/feature.ts']);
  assert.match(runCheck(repo, `${base}..HEAD`), /OK: 1 outgoing commit/);

  // A --no-verify commit that force-added nimbalyst-local.
  const leak = commitFiles(repo, git, 'leak', ['nimbalyst-local/plans/private.md'], { force: true });
  expectRefusal(() => runCheck(repo, `${base}..HEAD`), new RegExp(`${leak.slice(0, 9)} forbidden: nimbalyst-local/plans/private\\.md`));
  assert.match(runCheck(repo, `${base}..${clean}`), /OK/);

  // A merge commit measured against its FIRST parent, as GitHub renders it:
  // the branch has two small commits, but the merge from main's side sees them all.
  git(['checkout', '-q', '-b', 'wide', base]);
  assertInSandbox(repo, git);
  const half = Math.ceil((LARGE_COMMIT_FILE_LIMIT + 1) / 2);
  commitFiles(repo, git, 'wide 1', Array.from({ length: half }, (_, i) => `gen/a${i}.ts`));
  commitFiles(repo, git, 'wide 2', Array.from({ length: half }, (_, i) => `gen/b${i}.ts`));
  git(['checkout', '-q', clean, '-b', 'landing']);
  git(['merge', '--no-ff', '-q', '--no-verify', '-m', 'wide merge', 'wide']);
  const merge = git(['rev-parse', 'HEAD']).trim();
  // A contributor clone has not opted in, so the size of their merge is their business.
  assert.match(runCheck(repo, `${base}..HEAD`), /OK: 4 outgoing commit/);
  git(['config', SIZE_LIMIT_CONFIG_KEY, 'true']);
  expectRefusal(() => runCheck(repo, `${base}..HEAD`), new RegExp(`${merge.slice(0, 9)} size: ${half * 2} files changed`));
  assert.match(runCheck(repo, `${base}..HEAD`, { NIMBALYST_LARGE_COMMIT: '1' }), /OK: 4 outgoing commit/);
});

test('the pre-push hook runs the range check on merge-base..HEAD', () => {
  assert.match(readFileSync(PRE_PUSH, 'utf8'), /check-push-range\.mjs "\$base\.\.HEAD"/);
});
