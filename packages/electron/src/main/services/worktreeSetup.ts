/**
 * The setup step after a worktree is created: files the checkout needs but
 * git does not carry (`.env` files, local tool config) are copied in from
 * the project, then an optional command runs in a terminal tied to the
 * worktree, where the user can watch it -- installs can take minutes.
 *
 * Configured per project in workspace state (`worktreeSetup`), which stays on
 * this machine. Nothing here may overwrite a file in the worktree or reach
 * outside the project and the task folder.
 */

import * as fs from 'fs';
import * as path from 'path';
import log from 'electron-log/main';

const logger = log.scope('worktreeSetup');

export interface WorktreeSetupConfig {
  /** Paths relative to the project root, copied to the same place in the task folder */
  copy: string[];
  /** Runs in the task folder, in a terminal of the worktree */
  command?: string;
}

/** Older saved state has no setup, or only part of it */
export function normalizeWorktreeSetup(saved: Partial<WorktreeSetupConfig> | null | undefined): WorktreeSetupConfig {
  const copy = Array.isArray(saved?.copy) ? saved!.copy.filter((entry): entry is string => typeof entry === 'string') : [];
  const command = typeof saved?.command === 'string' && saved.command.trim() ? saved.command.trim() : undefined;
  return { copy, command };
}

/**
 * Where the task folder sits relative to the project. `project`: it mirrors
 * the project root (a project worktree, or a group's anchor), and holds the
 * nested clones listed in `members` at their own paths. `clone`: it is a
 * worktree of the one nested clone at `clonePath`, so only that clone's
 * entries apply, re-rooted.
 */
export type WorktreeSetupLayout =
  | { kind: 'project'; members: string[] }
  | { kind: 'clone'; clonePath: string };

export interface PlannedCopy {
  from: string;
  to: string;
}

export interface WorktreeSetupCopyPlan {
  copies: PlannedCopy[];
  /** Entries left out, with the reason, for the log */
  skipped: Array<{ entry: string; reason: string }>;
}

const normalizeEntry = (entry: string) => entry.trim().replace(/\\/g, '/').replace(/\/+$/, '');
const isWithin = (child: string, parent: string) => child === parent || child.startsWith(`${parent}/`);

/**
 * Which configured entries to copy where. `nestedClones` are every clone
 * inside the project, relative to it: an entry under one that the task folder
 * does not hold is skipped, since there is nowhere for it to go.
 */
export function planWorktreeSetupCopies(input: {
  projectPath: string;
  taskRoot: string;
  layout: WorktreeSetupLayout;
  nestedClones: string[];
  copy: readonly string[];
}): WorktreeSetupCopyPlan {
  const copies: PlannedCopy[] = [];
  const skipped: WorktreeSetupCopyPlan['skipped'] = [];
  const clones = input.nestedClones.map(normalizeEntry);
  for (const raw of input.copy) {
    const entry = normalizeEntry(raw);
    if (!entry) continue;
    if (path.isAbsolute(raw.trim()) || entry.split('/').some(segment => segment === '..')) {
      skipped.push({ entry: raw, reason: 'not a path inside the project' });
      continue;
    }
    let destination: string;
    if (input.layout.kind === 'clone') {
      const clone = normalizeEntry(input.layout.clonePath);
      if (!isWithin(entry, clone) || entry === clone) {
        skipped.push({ entry, reason: `not inside ${clone}, the repository this worktree branches` });
        continue;
      }
      destination = entry.slice(clone.length + 1);
    } else {
      const members = input.layout.members.map(normalizeEntry);
      const outsideMember = clones.find(clone => isWithin(entry, clone) && !members.includes(clone));
      if (outsideMember) {
        skipped.push({ entry, reason: `inside ${outsideMember}, which this worktree does not hold` });
        continue;
      }
      destination = entry;
    }
    const from = path.join(input.projectPath, ...entry.split('/'));
    const to = path.join(input.taskRoot, ...destination.split('/'));
    const relativeTo = path.relative(input.taskRoot, to);
    if (!relativeTo || relativeTo.startsWith('..') || path.isAbsolute(relativeTo)) {
      skipped.push({ entry, reason: 'would land outside the task folder' });
      continue;
    }
    copies.push({ from, to });
  }
  return { copies, skipped };
}

/**
 * Copies what the plan names. Never overwrites, never follows a symbolic
 * link, and skips a source whose real path leaves the project. Returns what
 * was copied; a failure of one entry is logged and the rest go on.
 */
export function copyWorktreeSetupFiles(projectPath: string, plan: WorktreeSetupCopyPlan): string[] {
  for (const { entry, reason } of plan.skipped) {
    logger.info('Worktree setup: skipped', { entry, reason });
  }
  if (plan.copies.length === 0) return [];
  const projectReal = fs.realpathSync(projectPath);
  const copied: string[] = [];
  for (const { from, to } of plan.copies) {
    try {
      if (!fs.existsSync(from)) {
        logger.info('Worktree setup: nothing to copy at', { from });
        continue;
      }
      const sourceReal = fs.realpathSync(from);
      const relative = path.relative(projectReal, sourceReal);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        logger.warn('Worktree setup: refusing a source outside the project', { from, sourceReal });
        continue;
      }
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.cpSync(from, to, { recursive: true, force: false, errorOnExist: false, dereference: false, verbatimSymlinks: true });
      copied.push(to);
    } catch (error) {
      logger.warn('Worktree setup: copy failed', { from, to, error });
    }
  }
  return copied;
}

/** The variables the setup command sees, so one script can serve every layout */
export function worktreeSetupEnv(input: {
  worktreePath: string;
  name: string;
  branch: string;
  projectPath: string;
  groupMembers: string[];
}): Record<string, string> {
  return {
    NIMBALYST_WORKTREE_PATH: input.worktreePath,
    NIMBALYST_WORKTREE_NAME: input.name,
    NIMBALYST_WORKTREE_BRANCH: input.branch,
    NIMBALYST_WORKTREE_PROJECT_PATH: input.projectPath,
    NIMBALYST_WORKTREE_GROUP_MEMBERS: input.groupMembers.join(':'),
  };
}
