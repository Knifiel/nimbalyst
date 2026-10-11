import simpleGit, { SimpleGit, SimpleGitOptions } from 'simple-git';
import { GIT_INHERITED_ENV_UNSAFE } from './gitInheritedEnvUnsafe';

/**
 * A simple-git instance for background reads (status, branch lookups) that
 * must never refresh, and so lock, `.git/index`. A locked index makes a
 * concurrent user command fail: `git pull --rebase` cannot reapply its
 * autostash and leaves the user's dirty edits parked in the stash.
 *
 * GIT_OPTIONAL_LOCKS=0 is the environment form of `--no-optional-locks`, which
 * simple-git cannot pass. `core.optionalLocks` is NOT a git config key; passing
 * it via `config` is silently ignored. Supplying any env makes simple-git scan
 * it, hence the unsafe flags (see gitInheritedEnvUnsafe).
 */
export function simpleGitReadOnly(baseDir: string, options?: Partial<SimpleGitOptions>): SimpleGit {
  return simpleGit(baseDir, { ...options, unsafe: GIT_INHERITED_ENV_UNSAFE })
    .env({ ...process.env, GIT_OPTIONAL_LOCKS: '0' });
}
