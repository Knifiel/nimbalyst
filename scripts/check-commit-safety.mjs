#!/usr/bin/env node
// Pre-commit / pre-merge-commit gate. Refuses a commit when the index:
//   - stages anything under nimbalyst-local/ or any agent-mistakes.md
//   - stages a NEW path that matches a .gitignore rule (it had to be force-added)
//   - stages more than LARGE_COMMIT_FILE_LIMIT files, on clones that opted in with
//     `git config nimbalyst.commitSizeLimit true` (NIMBALYST_LARGE_COMMIT=1 overrides)
//
// It diffs the whole index against HEAD, so a merge in progress is measured by
// what the merge commit will actually contain, not by the files the user
// staged by hand. `git merge --no-ff` of a normal PR runs this through the
// pre-merge-commit hook; `git merge --no-commit` followed by `git commit` runs
// it through pre-commit. Both see the same index.
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  LARGE_COMMIT_FILE_LIMIT,
  LARGE_COMMIT_OVERRIDE_ENV,
  exceedsFileLimit,
  findForbiddenPaths,
  readSizeLimitEnforced,
  splitNul,
} from './commit-safety-policy.mjs';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * Parse `git diff --cached --name-status -z` output into {status, path}
 * entries. Renames and copies carry two paths; the destination is what lands.
 */
export function parseNameStatus(output) {
  const fields = splitNul(output);
  const entries = [];
  for (let i = 0; i < fields.length; ) {
    const status = fields[i][0];
    if (status === 'R' || status === 'C') {
      entries.push({ status, path: fields[i + 2], from: fields[i + 1] });
      i += 3;
    } else {
      entries.push({ status, path: fields[i + 1] });
      i += 2;
    }
  }
  return entries;
}

/**
 * Pure decision over the staged entries. `ignoredAdded` is the subset of newly
 * added paths that `git check-ignore` matched.
 */
export function evaluateStagedCommit({ entries, ignoredAdded, env = process.env, sizeLimitEnforced = true }) {
  const landing = entries.filter((entry) => entry.status !== 'D');
  const forbidden = findForbiddenPaths(landing.map((entry) => entry.path));
  const ignoredSet = new Set(ignoredAdded);
  const forbiddenSet = new Set(forbidden.map((entry) => entry.path));
  const ignored = landing
    .filter((entry) => entry.status === 'A' && ignoredSet.has(entry.path) && !forbiddenSet.has(entry.path))
    .map((entry) => ({ path: entry.path, reason: 'matches a .gitignore rule and was force-added' }));
  const fileCount = entries.length;
  const tooLarge = exceedsFileLimit(fileCount, env, sizeLimitEnforced);
  return {
    ok: forbidden.length === 0 && ignored.length === 0 && !tooLarge,
    forbidden: [...forbidden, ...ignored],
    fileCount,
    tooLarge,
  };
}

function git(args, { input, allowFailure = false } = {}) {
  const result = spawnSync('git', args, { encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(' ')} failed (exit ${result.status}): ${result.stderr}`);
  }
  return result.stdout;
}

function readStagedEntries() {
  const headExists = spawnSync('git', ['rev-parse', '--verify', '-q', 'HEAD'], { encoding: 'utf8' }).status === 0;
  const base = headExists ? 'HEAD' : EMPTY_TREE;
  return parseNameStatus(git(['diff', '--cached', '--name-status', '-z', base]));
}

function readIgnoredAdded(entries) {
  const added = entries.filter((entry) => entry.status === 'A').map((entry) => entry.path);
  if (added.length === 0) return [];
  // --no-index: an added path is in the index by definition, and check-ignore
  // would otherwise stay silent about it. Exit 1 just means "nothing matched".
  const output = git(['check-ignore', '--no-index', '-z', '--stdin'], {
    input: `${added.join('\0')}\0`,
    allowFailure: true,
  });
  return splitNul(output);
}

function shellQuote(path) {
  return /^[\w./@-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}

export function formatRefusal(result, { merging }) {
  const lines = [];
  if (result.forbidden.length > 0) {
    lines.push('[pre-commit] ERROR: refusing to commit paths that must never be committed:');
    for (const { path, reason } of result.forbidden) lines.push(`  ${path}  (${reason})`);
    lines.push('[pre-commit] Unstage them with:');
    lines.push(`  git restore --staged -- ${result.forbidden.map(({ path }) => shellQuote(path)).join(' ')}`);
    if (merging) {
      lines.push('[pre-commit] This is a merge. If the branch being merged carries these files, do not land it;');
      lines.push('[pre-commit] abort with `git merge --abort` and report it.');
    }
  }
  if (result.tooLarge) {
    lines.push(
      `[pre-commit] ERROR: this commit touches ${result.fileCount} files; the limit is ${LARGE_COMMIT_FILE_LIMIT}.`,
    );
    lines.push('[pre-commit] A merge this wide usually means main was merged into a PR branch, or a');
    lines.push('[pre-commit] whole directory was staged by accident (2026-10-10: a four-file PR became a');
    lines.push('[pre-commit] 2,800-file merge). Review `git diff --cached --stat` before anything else.');
    lines.push(`[pre-commit] If the size is intended, rerun with ${LARGE_COMMIT_OVERRIDE_ENV}=1 in the environment.`);
  }
  return lines.join('\n');
}

function main() {
  const entries = readStagedEntries();
  const result = evaluateStagedCommit({
    entries,
    ignoredAdded: readIgnoredAdded(entries),
    sizeLimitEnforced: readSizeLimitEnforced(),
  });
  if (result.ok) return;
  const merging = spawnSync('git', ['rev-parse', '--verify', '-q', 'MERGE_HEAD'], { encoding: 'utf8' }).status === 0;
  console.error(formatRefusal(result, { merging }));
  process.exit(1);
}

// pathToFileURL, not a `file://` template: process.argv[1] is a backslashed
// drive path on Windows while import.meta.url is forward-slashed.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`[pre-commit] ERROR: ${error.message}`);
    process.exit(1);
  }
}
