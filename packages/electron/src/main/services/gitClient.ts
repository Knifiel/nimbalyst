import { simpleGit, type SimpleGit, type SimpleGitOptions } from 'simple-git';
import { GIT_INHERITED_ENV_UNSAFE } from './gitInheritedEnvUnsafe';

export type GitEnv = Record<string, string | undefined>;

/**
 * The one way the main process creates a simple-git instance.
 *
 * simple-git 4 guards every GIT_* variable, plus EDITOR, PAGER and a few
 * others: an inherited one is stripped from git's environment, and one handed
 * over through `.env()` rejects the task, unless the instance names it in
 * `allowEnvironment`. Without that a push stops seeing the user's
 * GIT_SSH_COMMAND or GIT_ASKPASS, and our own GIT_OPTIONAL_LOCKS throws.
 *
 * The environment git runs with here is always the user's own (process.env,
 * or their login shell's for hooks): the same one git sees in their terminal.
 * So every key of it is allowed, and an explicit one gets the unsafe opt-ins
 * for the same reason (see gitInheritedEnvUnsafe). Arguments are not loosened;
 * callers never pass untrusted config or `-c` values (GHSA-x6jw-m9v5-85vh).
 *
 * `env` replaces git's environment entirely, like `.env(object)`, so callers
 * spread process.env into it themselves.
 */
export function createGit(baseDir?: string, options: Partial<SimpleGitOptions> = {}, env?: GitEnv): SimpleGit {
  const source = env ?? process.env;
  const allowEnvironment = [...new Set([...(options.allowEnvironment ?? []), ...Object.keys(source)])];
  const unsafe = env ? { ...GIT_INHERITED_ENV_UNSAFE, ...options.unsafe } : options.unsafe;
  const resolved: Partial<SimpleGitOptions> = { ...options, allowEnvironment, ...(unsafe ? { unsafe } : {}) };
  const git = baseDir === undefined ? simpleGit(resolved) : simpleGit(baseDir, resolved);
  return env ? git.env(env as Record<string, string>) : git;
}
