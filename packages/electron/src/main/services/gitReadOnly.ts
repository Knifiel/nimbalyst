import type { SimpleGit, SimpleGitOptions } from 'simple-git';
import { createGit } from './gitClient';

/**
 * A simple-git instance for background reads (status, branch lookups) that
 * must never refresh, and so lock, `.git/index`. A locked index makes a
 * concurrent user command fail: `git pull --rebase` cannot reapply its
 * autostash and leaves the user's dirty edits parked in the stash.
 *
 * GIT_OPTIONAL_LOCKS=0 is the environment form of `--no-optional-locks`, which
 * simple-git cannot pass. `core.optionalLocks` is NOT a git config key; passing
 * it via `config` is silently ignored. createGit allows that environment.
 */
export function simpleGitReadOnly(baseDir: string, options?: Partial<SimpleGitOptions>): SimpleGit {
  return createGit(baseDir, options, { ...process.env, GIT_OPTIONAL_LOCKS: '0' });
}
