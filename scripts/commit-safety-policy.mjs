// Shared policy for the pre-commit, pre-merge-commit, and pre-push git-safety
// gates. One place for the constants so the commit-time and push-time checks
// can never disagree about what counts as a forbidden path or an oversized
// commit.
//
// Background (2026-10-10): an agent landing a four-file contributor PR produced
// a 2,800-file merge commit that carried the maintainer's gitignored
// nimbalyst-local/ working files onto public main. Every check here exists to
// make that shape of commit impossible to create and, failing that, impossible
// to push.
import { spawnSync } from 'node:child_process';

/** A commit (or merge) that touches more files than this is refused. */
export const LARGE_COMMIT_FILE_LIMIT = 200;

/** Set to '1' to let one deliberate oversized commit or push through. */
export const LARGE_COMMIT_OVERRIDE_ENV = 'NIMBALYST_LARGE_COMMIT';

/**
 * The file-count limit is opt-in per clone, like the push allowlist in
 * check-push-destination.mjs. It guards against an agent on the maintainer's
 * checkout; a contributor running `git merge main` on their own branch would
 * otherwise hit it for a normal workflow. Enable it once on a maintainer machine:
 *
 *   git config nimbalyst.commitSizeLimit true
 *
 * The forbidden-path checks apply everywhere; they cost contributors nothing.
 */
export const SIZE_LIMIT_CONFIG_KEY = 'nimbalyst.commitSizeLimit';

export function readSizeLimitEnforced(cwd = process.cwd()) {
  const result = spawnSync('git', ['config', '--get', '--type=bool', SIZE_LIMIT_CONFIG_KEY], { cwd, encoding: 'utf8' });
  return result.status === 0 && result.stdout.trim() === 'true';
}

/** Repo-relative directory prefixes that must never be committed. */
const FORBIDDEN_PREFIXES = ['nimbalyst-local/'];

/** Basenames that must never be committed at any depth. */
const FORBIDDEN_BASENAMES = new Set(['agent-mistakes.md']);

/** Returns a human reason when a repo-relative path is never allowed in a commit. */
export function forbiddenPathReason(repoPath) {
  const normalized = repoPath.replace(/\\/g, '/').replace(/^\.\//, '');
  for (const prefix of FORBIDDEN_PREFIXES) {
    if (normalized === prefix.slice(0, -1) || normalized.startsWith(prefix)) {
      return `${prefix} is local-only and gitignored`;
    }
  }
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
  if (FORBIDDEN_BASENAMES.has(basename)) {
    return `${basename} is the private agent mistake log`;
  }
  return undefined;
}

export function findForbiddenPaths(paths) {
  return paths
    .map((path) => ({ path, reason: forbiddenPathReason(path) }))
    .filter(({ reason }) => reason !== undefined);
}

export function isLargeCommitOverridden(env = process.env) {
  return env[LARGE_COMMIT_OVERRIDE_ENV] === '1';
}

/** True when the limit is enforced here and `count` exceeds it without the override. */
export function exceedsFileLimit(count, env = process.env, enforced = true) {
  return enforced && count > LARGE_COMMIT_FILE_LIMIT && !isLargeCommitOverridden(env);
}

/** Split a NUL-delimited git output into entries, dropping the trailing empty one. */
export function splitNul(output) {
  return output.split('\0').filter((entry) => entry.length > 0);
}
