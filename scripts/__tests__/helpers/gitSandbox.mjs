import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Git hooks export GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE pointing at the
// REAL checkout, and those override `cwd`. A pre-push hook running this suite
// would otherwise commit fixtures straight onto the developer's live branch
// (2026-07-22 and 2026-07-24 incidents). Strip every GIT_* var, pin config
// resolution to a file that does not exist, and stop repo discovery from
// walking above the temp dir.
export function sandboxEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  delete env.NIMBALYST_LARGE_COMMIT;
  const missingConfig = path.join(tmpdir(), 'nim-git-sandbox-absent-gitconfig');
  env.GIT_CONFIG_GLOBAL = missingConfig;
  env.GIT_CONFIG_SYSTEM = missingConfig;
  env.GIT_CEILING_DIRECTORIES = realpathSync(tmpdir());
  return { ...env, ...extra };
}

// Fixtures NEVER borrow a real contributor's identity; see check-push-authors.
export const FIXTURE_AUTHOR = { name: 'Ada Contributor', email: 'ada@nimbalyst.dev' };

export function makeGit(cwd, extraEnv = {}) {
  const env = sandboxEnv(extraEnv);
  return (args, options = {}) =>
    execFileSync('git', [
      '-c', `user.name=${FIXTURE_AUTHOR.name}`,
      '-c', `user.email=${FIXTURE_AUTHOR.email}`,
      '-c', 'commit.gpgsign=false',
      ...args,
    ], { cwd, encoding: 'utf8', env, ...options });
}

// Re-checked before every mutating call: the failure mode is a hijacked repo
// resolution, which is only observable at the moment git actually runs.
export function assertInSandbox(cwd, git) {
  assert.equal(
    realpathSync(git(['rev-parse', '--show-toplevel']).trim()),
    realpathSync(cwd),
    'git resolved a repository outside the scratch sandbox; refusing to mutate',
  );
}

/** Scratch repo under os.tmpdir() with an initial commit on `main`. */
export function makeScratchRepo(t, prefix, extraEnv = {}) {
  const repo = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = makeGit(repo, extraEnv);
  git(['init', '-q', '-b', 'main']);
  assertInSandbox(repo, git);
  return { repo, git };
}

export function writeFile(repo, relative, content = `${relative}\n`) {
  const full = path.join(repo, relative);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
  return relative;
}

export function commitFiles(repo, git, message, files, { force = false } = {}) {
  assertInSandbox(repo, git);
  for (const file of files) {
    if (!existsSync(path.join(repo, file))) writeFile(repo, file);
  }
  git(['add', ...(force ? ['-f'] : []), '--', ...files]);
  git(['commit', '-q', '-m', message]);
  return git(['rev-parse', 'HEAD']).trim();
}
