#!/usr/bin/env node
// Pre-push gate over every outgoing commit. A commit made with --no-verify
// skips pre-commit, so this re-applies the same policy to the range about to
// leave the machine:
//   - no commit may touch nimbalyst-local/ or any agent-mistakes.md
//   - no commit may change more than LARGE_COMMIT_FILE_LIMIT files, on clones
//     that opted in with `git config nimbalyst.commitSizeLimit true` (a merge is
//     measured against its first parent, which is what GitHub shows)
//   - no commit may have more than two parents
// NIMBALYST_LARGE_COMMIT=1 lifts the file-count limit for one deliberate push.
//
// Only the given range is inspected (the hook passes merge-base..HEAD), so the
// cost is one rev-list plus one diff-tree per outgoing commit.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  LARGE_COMMIT_FILE_LIMIT,
  LARGE_COMMIT_OVERRIDE_ENV,
  exceedsFileLimit,
  findForbiddenPaths,
  readSizeLimitEnforced,
  splitNul,
} from './commit-safety-policy.mjs';

export const MAX_PARENTS = 2;

/** Parse `git rev-list --parents` output into {sha, parents} entries. */
export function parseRevListParents(output) {
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, ...parents] = line.trim().split(/\s+/);
      return { sha, parents };
    });
}

/**
 * Pure decision over a list of commits, each with its parents and the paths
 * it changes relative to its first parent.
 */
export function evaluateCommits(commits, env = process.env, sizeLimitEnforced = true) {
  const problems = [];
  for (const { sha, parents, paths } of commits) {
    if (parents.length > MAX_PARENTS) {
      problems.push({ sha, kind: 'parents', detail: `${parents.length} parents (octopus merge)` });
    }
    const forbidden = findForbiddenPaths(paths);
    if (forbidden.length > 0) {
      problems.push({ sha, kind: 'forbidden', detail: forbidden.map(({ path }) => path).join(', ') });
    }
    if (exceedsFileLimit(paths.length, env, sizeLimitEnforced)) {
      problems.push({ sha, kind: 'size', detail: `${paths.length} files changed (limit ${LARGE_COMMIT_FILE_LIMIT})` });
    }
  }
  return problems;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

export function readCommits(range) {
  return parseRevListParents(git(['rev-list', '--parents', range])).map(({ sha, parents }) => {
    const args = parents.length === 0
      ? ['diff-tree', '-r', '--root', '--no-commit-id', '--name-only', '-z', sha]
      : ['diff-tree', '-r', '--no-commit-id', '--name-only', '-z', parents[0], sha];
    return { sha, parents, paths: splitNul(git(args)) };
  });
}

function resolveRange() {
  if (process.argv[2]) return process.argv[2];
  try {
    return `${git(['merge-base', 'HEAD', 'origin/main']).trim()}..HEAD`;
  } catch {
    return 'HEAD~1..HEAD';
  }
}

function main() {
  const range = resolveRange();
  const commits = readCommits(range);
  const problems = evaluateCommits(commits, process.env, readSizeLimitEnforced());
  if (problems.length === 0) {
    console.log(`[check-push-range] OK: ${commits.length} outgoing commit(s) in ${range} pass the commit-safety policy.`);
    return;
  }
  console.error('[check-push-range] ERROR: refusing to push commits that violate the commit-safety policy:');
  for (const { sha, kind, detail } of problems) {
    console.error(`  ${sha.slice(0, 9)} ${kind}: ${detail}`);
  }
  console.error('[check-push-range] Forbidden paths must be removed from history before pushing (never force-push');
  console.error('[check-push-range] a published branch; stop and report instead). An intentionally large commit');
  console.error(`[check-push-range] can be pushed once with ${LARGE_COMMIT_OVERRIDE_ENV}=1.`);
  process.exit(1);
}

// pathToFileURL, not a `file://` template: process.argv[1] is a backslashed
// drive path on Windows while import.meta.url is forward-slashed.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
