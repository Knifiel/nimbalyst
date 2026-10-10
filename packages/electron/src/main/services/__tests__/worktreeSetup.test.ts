// @vitest-environment node
/**
 * The worktree setup step copies files the checkout needs but git does not
 * carry. What must never happen is a copy overwriting work in the worktree,
 * or reaching outside the project or the task folder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { copyWorktreeSetupFiles, normalizeWorktreeSetup, planWorktreeSetupCopies } from '../worktreeSetup';

vi.mock('electron-log/main', () => ({ default: { scope: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } }));

describe('planWorktreeSetupCopies', () => {
  const base = { projectPath: '/work', taskRoot: '/wt/task', nestedClones: ['api', 'web'] };
  const targets = (plan: ReturnType<typeof planWorktreeSetupCopies>) => plan.copies.map(copy => copy.to);

  it('mirrors the project, skipping clones the task folder does not hold', () => {
    const plan = planWorktreeSetupCopies({
      ...base, layout: { kind: 'project', members: ['api'] }, copy: ['.claude/', 'api/.env', 'web/.env.local'],
    });
    expect(targets(plan)).toEqual(['/wt/task/.claude', '/wt/task/api/.env']);
    expect(plan.skipped.map(skip => skip.entry)).toEqual(['web/.env.local']);
  });

  it('re-roots a clone\'s entries for a worktree of that clone alone', () => {
    const plan = planWorktreeSetupCopies({
      ...base, taskRoot: '/work_worktrees/fix', layout: { kind: 'clone', clonePath: 'api' }, copy: ['api/.env', '.claude', 'api'],
    });
    expect(targets(plan)).toEqual(['/work_worktrees/fix/.env']);
    expect(plan.skipped).toHaveLength(2);
  });

  it('refuses entries that leave the project', () => {
    const plan = planWorktreeSetupCopies({
      ...base, layout: { kind: 'project', members: [] }, copy: ['../secrets', '/etc/passwd', 'ok/../../x'],
    });
    expect(plan.copies).toEqual([]);
    expect(plan.skipped).toHaveLength(3);
  });

  it('reads older saved state that has no setup or only part of it', () => {
    expect(normalizeWorktreeSetup(undefined)).toEqual({ copy: [], command: undefined });
    expect(normalizeWorktreeSetup({ command: '  ' })).toEqual({ copy: [], command: undefined });
  });
});

describe('copyWorktreeSetupFiles', () => {
  let root: string;
  let project: string;
  let task: string;

  beforeEach(() => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nim-worktree-setup-')));
    project = path.join(root, 'work');
    task = path.join(root, 'task');
    fs.mkdirSync(path.join(project, 'api'), { recursive: true });
    fs.mkdirSync(path.join(project, '.claude', 'commands'), { recursive: true });
    fs.mkdirSync(path.join(task, 'api'), { recursive: true });
    fs.writeFileSync(path.join(project, 'api', '.env'), 'PROJECT=1');
    fs.writeFileSync(path.join(project, '.claude', 'commands', 'run.md'), 'run');
    fs.writeFileSync(path.join(root, 'outside.env'), 'SECRET=1');
    fs.symlinkSync(path.join(root, 'outside.env'), path.join(project, 'linked.env'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const run = (copy: string[]) => copyWorktreeSetupFiles(project, planWorktreeSetupCopies({
    projectPath: project, taskRoot: task, layout: { kind: 'project', members: ['api'] }, nestedClones: ['api'], copy,
  }));

  it('copies folders and files, and never overwrites one already in the worktree', () => {
    fs.writeFileSync(path.join(task, 'api', '.env'), 'WORKTREE=1');

    run(['.claude', 'api/.env', 'missing.env']);

    expect(fs.readFileSync(path.join(task, '.claude', 'commands', 'run.md'), 'utf8')).toBe('run');
    expect(fs.readFileSync(path.join(task, 'api', '.env'), 'utf8')).toBe('WORKTREE=1');
    expect(fs.existsSync(path.join(task, 'missing.env'))).toBe(false);
  });

  it('refuses a source that resolves outside the project', () => {
    expect(run(['linked.env'])).toEqual([]);
    expect(fs.existsSync(path.join(task, 'linked.env'))).toBe(false);
  });
});
