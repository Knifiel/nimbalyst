// @vitest-environment node
/**
 * Creating a worktree group against real repositories: an umbrella repo that
 * ignores two nested clones. A group is several checkouts made one after
 * another, so what matters is the failure paths -- a conflict found late must
 * leave no folder and no branch in any repository.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitWorktreeService } from '../GitWorktreeService';
import type { Worktree } from '../WorktreeStore';
import { createWorktreeGroup, type WorktreeGroupCreateDeps } from '../worktreeGroupCreate';
import { createGit } from '../gitClient';
import { assertGitSandbox, gitSandboxEnv } from '../testSupport/gitTestSandbox';

vi.mock('../GitOperationLogService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../GitOperationLogService')>()),
  getGitOperationLogService: () => ({}),
  recordGitActivity: (_service: unknown, _workspacePath: string, _args: string[], operation: () => Promise<unknown>) =>
    operation(),
}));

const fixtureGit = (dir: string) => createGit(dir, {}, gitSandboxEnv(undefined, { pinConfigPaths: false }));

async function initRepo(dir: string, files: Record<string, string> = { 'README.md': 'hi' }): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  const git = fixtureGit(dir);
  await git.init();
  await git.addConfig('user.email', 'test@example.com', false, 'local');
  await git.addConfig('user.name', 'Test', false, 'local');
  await git.addConfig('commit.gpgsign', 'false', false, 'local');
  assertGitSandbox(dir);
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  await git.add(Object.keys(files));
  await git.commit('init');
}

/** The rows the store would hold, keyed by id */
function memoryStore() {
  const rows = new Map<string, Worktree>();
  return {
    rows,
    async create(worktree: Worktree) {
      if ([...rows.values()].some(row => row.path === worktree.path)) throw new Error('duplicate path');
      rows.set(worktree.id, worktree);
    },
    async delete(id: string) { rows.delete(id); },
    async getAllNames() { return new Set([...rows.values()].map(row => row.name)); },
    async getAllPaths() { return new Set([...rows.values()].map(row => row.path)); },
  };
}

describe('createWorktreeGroup', () => {
  const service = new GitWorktreeService();
  let root: string;
  let work: string;
  let api: string;
  let web: string;
  let store: ReturnType<typeof memoryStore>;

  const deps = (): WorktreeGroupCreateDeps => ({
    service,
    store,
    knownRepos: [work, api, web],
    worktreesDir: path.join(root, 'work_worktrees'),
  });
  const branches = async (repo: string) =>
    (await fixtureGit(repo).raw(['for-each-ref', '--format=%(refname:short)', 'refs/heads/worktree/'])).trim();

  beforeEach(async () => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nimbalyst-group-create-')));
    work = path.join(root, 'work');
    await initRepo(work, { '.gitignore': '/api/\n/web/\n' });
    api = path.join(work, 'api');
    web = path.join(work, 'web');
    await initRepo(api);
    await initRepo(web);
    store = memoryStore();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('puts each clone at its own path inside the task folder, on one branch, leaving the umbrella clean', async () => {
    const { anchor, members } = await createWorktreeGroup(work, {
      name: 'task', nameSource: 'user', members: [{ repoPath: api }, { repoPath: web }],
    }, deps());

    const taskFolder = path.join(root, 'work_worktrees', 'task');
    expect(anchor).toMatchObject({ path: taskFolder, branch: 'worktree/task', groupId: anchor.id, sourceFolderPath: work });
    expect(members.map(member => [member.path, member.sourceFolderPath, member.groupId])).toEqual([
      [path.join(taskFolder, 'api'), api, anchor.id],
      [path.join(taskFolder, 'web'), web, anchor.id],
    ]);
    for (const repo of [work, api, web]) expect(await branches(repo)).toBe('worktree/task');
    expect(fs.existsSync(path.join(taskFolder, 'api', 'README.md'))).toBe(true);
    expect((await fixtureGit(anchor.path).raw(['status', '--porcelain'])).trim()).toBe('');
    expect(store.rows.size).toBe(3);
  });

  it('creates nothing anywhere when the last member already has the branch', async () => {
    await fixtureGit(web).raw(['branch', 'worktree/task']);

    await expect(createWorktreeGroup(work, {
      name: 'task', nameSource: 'user', members: [{ repoPath: api }, { repoPath: web }],
    }, deps())).rejects.toThrow(/worktree\/task/);

    expect(fs.existsSync(path.join(root, 'work_worktrees', 'task'))).toBe(false);
    expect(await branches(work)).toBe('');
    expect(await branches(api)).toBe('');
    expect(store.rows.size).toBe(0);
  });

  it('removes the task folder again when the project does not ignore a member', async () => {
    const vendored = path.join(work, 'vendored');
    await initRepo(vendored);

    await expect(createWorktreeGroup(work, {
      name: 'task', nameSource: 'user', members: [{ repoPath: vendored }],
    }, { ...deps(), knownRepos: [work, vendored] })).rejects.toThrow(/does not ignore vendored/);

    expect(fs.existsSync(path.join(root, 'work_worktrees', 'task'))).toBe(false);
    expect(await branches(work)).toBe('');
    expect(store.rows.size).toBe(0);
  });

  it('rolls back the anchor and earlier members when a member checkout fails', async () => {
    // A post-checkout hook that fails, as a repository's own tooling might
    const hook = path.join(web, '.git', 'hooks', 'post-checkout');
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });

    await expect(createWorktreeGroup(work, {
      name: 'task', nameSource: 'user', members: [{ repoPath: api }, { repoPath: web }],
    }, deps())).rejects.toThrow();

    expect(fs.existsSync(path.join(root, 'work_worktrees', 'task'))).toBe(false);
    for (const repo of [work, api, web]) expect(await branches(repo)).toBe('');
    expect(store.rows.size).toBe(0);
  });

  it('creates nothing when a member base branch does not exist', async () => {
    await expect(createWorktreeGroup(work, {
      name: 'task', nameSource: 'user', members: [{ repoPath: api }, { repoPath: web, baseBranch: 'no-such-branch' }],
    }, deps())).rejects.toThrow(/'no-such-branch' does not exist/);

    expect(fs.existsSync(path.join(root, 'work_worktrees', 'task'))).toBe(false);
    for (const repo of [work, api, web]) expect(await branches(repo)).toBe('');
  });

  it('refuses a repository outside the project or not among its repositories', async () => {
    const elsewhere = path.join(root, 'elsewhere');
    await initRepo(elsewhere);

    await expect(createWorktreeGroup(work, { members: [{ repoPath: elsewhere }] }, deps()))
      .rejects.toThrow(/not a repository inside/);
    await expect(createWorktreeGroup(work, { members: [{ repoPath: path.join(work, 'missing') }] }, deps()))
      .rejects.toThrow(/not one of this project's repositories/);
  });
});
