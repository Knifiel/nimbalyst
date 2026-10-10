// @vitest-environment node
/**
 * An agent's new worktree holds the repositories the user picks in the New
 * Worktree dialog, unless the agent names them -- and never a path that is not
 * one of the project's own clones.
 */
import { describe, expect, it } from 'vitest';
import { resolveAgentWorktreeRepos } from '../agentWorktreeRepos';

const workspacePath = '/work';
const knownRepos = ['/work', '/work/api', '/work/apps/builder', '/elsewhere/attached'];

describe('the repositories an agent-created worktree holds', () => {
  it('follows the user\'s last group choice, and only a group choice', () => {
    expect(resolveAgentWorktreeRepos({ workspacePath, knownRepos, remembered: ['/work', '/work/apps/builder', '/work/gone'] }))
      .toEqual(['/work/apps/builder']);
    // A single-repository choice or none: the project repository alone
    expect(resolveAgentWorktreeRepos({ workspacePath, knownRepos, remembered: ['/work/api'] })).toEqual([]);
    expect(resolveAgentWorktreeRepos({ workspacePath, knownRepos })).toEqual([]);
  });

  it('takes the repositories the agent names, by relative path or folder name', () => {
    expect(resolveAgentWorktreeRepos({
      workspacePath, knownRepos, remembered: ['/work', '/work/api'], requested: ['builder', './api/', 'apps/builder'],
    })).toEqual(['/work/apps/builder', '/work/api']);
    expect(resolveAgentWorktreeRepos({ workspacePath, knownRepos, remembered: ['/work', '/work/api'], requested: [] })).toEqual([]);
  });

  it('refuses a name that is not one of the project\'s clones, listing the ones there are', () => {
    expect(() => resolveAgentWorktreeRepos({ workspacePath, knownRepos, requested: ['attached'] }))
      .toThrow('"attached" is not a repository cloned in this project. Repositories: api, apps/builder');
    expect(() => resolveAgentWorktreeRepos({ workspacePath, knownRepos, requested: ['../etc'] })).toThrow('not a repository');
  });
});
