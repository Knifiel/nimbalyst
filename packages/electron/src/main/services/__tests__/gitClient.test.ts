// @vitest-environment node

/**
 * simple-git 4 strips every inherited GIT_* variable (and EDITOR, PAGER, ...)
 * from git's environment and rejects any it is handed through `.env()`, unless
 * the instance allows it by name. git in Nimbalyst must see the same
 * environment it sees in the user's terminal (GIT_SSH_COMMAND, GIT_ASKPASS),
 * and our own GIT_OPTIONAL_LOCKS / GIT_INDEX_FILE must not throw.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGit } from '../gitClient';

let repo: string;
const saved: Record<string, string | undefined> = {};
const AMBIENT = { GIT_AUTHOR_NAME: 'Ambient Author', GIT_AUTHOR_EMAIL: 'ambient@example.com' };

beforeEach(() => {
  repo = realpathSync(mkdtempSync(path.join(tmpdir(), 'nim-git-client-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env: { ...process.env, ...Object.fromEntries(Object.keys(AMBIENT).map(k => [k, ''])) } });
  git('init', '-q');
  git('config', 'user.name', 'Config Author');
  git('config', 'user.email', 'config@example.com');
  git('config', 'commit.gpgsign', 'false');
  // Never touch the checkout the suite runs in.
  expect(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: repo, encoding: 'utf8' }).trim()).toBe(repo);
  writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  for (const key of Object.keys(AMBIENT)) saved[key] = process.env[key];
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(repo, { recursive: true, force: true });
});

const author = () => execFileSync('git', ['log', '-1', '--format=%an <%ae>'], { cwd: repo, encoding: 'utf8' }).trim();

describe('createGit', () => {
  it('lets git see GIT_* variables inherited from the app environment', async () => {
    Object.assign(process.env, AMBIENT);
    const git = createGit(repo);
    await git.add('a.txt');
    await git.commit('first');
    expect(author()).toBe('Ambient Author <ambient@example.com>');
  });

  it('passes an explicit environment, including our own GIT_OPTIONAL_LOCKS, without rejecting the task', async () => {
    const git = createGit(repo, {}, { ...process.env, ...AMBIENT, GIT_OPTIONAL_LOCKS: '0' });
    await git.add('a.txt');
    await git.commit('first');
    expect(author()).toBe('Ambient Author <ambient@example.com>');
    expect((await git.status()).isClean()).toBe(true);
  });

  it('accepts the user-owned variables the unsafe guard used to refuse', async () => {
    const git = createGit(repo, {}, { ...process.env, GIT_ASKPASS: '/usr/bin/true', GIT_EDITOR: 'true', GIT_PAGER: 'cat' });
    expect((await git.status()).files.map(f => f.path)).toEqual(['a.txt']);
  });
});
