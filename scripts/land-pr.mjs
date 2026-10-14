#!/usr/bin/env node
// Deterministic landing of a reviewed contributor PR into local main.
//
//   node scripts/land-pr.mjs <PR#> [--dry-run | --verify]
//
// What it does, in order, stopping at the first failure:
//   1. Reads the PR from GitHub (state, head SHA, base branch, changed-file count).
//   2. Requires the checkout to be on main with nothing staged, and refuses if a
//      file the PR touches is modified locally.
//   3. Fetches origin/main and the PR head; the fetched SHA must equal GitHub's.
//   4. Fast-forwards main to origin/main when it is behind; refuses if diverged.
//   5. Refuses if any commit the PR brings in is itself a merge (the contributor
//      merged main into their branch; GitHub shows that as a huge diff).
//   6. Previews the merge: the files between merge-base and PR head must not
//      exceed the PR's own changed-file count by more than LANDING_FILE_MARGIN
//      and must not include forbidden paths.
//   7. `git merge --no-ff` with GitHub's merge-commit message, then proves the
//      shape of HEAD: first parent is the old tip, second parent is the PR head,
//      and the first-parent diff matches the preview.
//   8. Stops. The existing pre-push gate runs when you `git push origin main`.
//
// It never checks out another branch, never pushes, and never merges main into
// the contributor's branch. `--dry-run` stops after step 6. `--verify` runs
// only step 7 against the current HEAD, for use after a manual conflict
// resolution.
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { LARGE_COMMIT_FILE_LIMIT, findForbiddenPaths, splitNul } from './commit-safety-policy.mjs';

/** The merge may touch this many files beyond the PR's own count (conflict resolution, lockfile). */
export const LANDING_FILE_MARGIN = 5;

export const REQUIRED_BASE_BRANCH = 'main';

export class LandingError extends Error {}

export function parseArgs(argv) {
  const positional = argv.filter((arg) => !arg.startsWith('--'));
  const flags = new Set(argv.filter((arg) => arg.startsWith('--')));
  const raw = positional[0];
  const match = raw && /(?:^|\/pull\/)(\d+)(?:$|\/)/.exec(raw.trim());
  const prNumber = match ? Number(match[1]) : undefined;
  return { prNumber, dryRun: flags.has('--dry-run'), verify: flags.has('--verify') };
}

/** Pure merge-preview decision, so the file-count policy is testable without git. */
export function evaluatePreview({ previewPaths, changedFiles }) {
  const forbidden = findForbiddenPaths(previewPaths);
  const limit = changedFiles + LANDING_FILE_MARGIN;
  const problems = [];
  if (forbidden.length > 0) {
    problems.push(`the merge would add forbidden paths: ${forbidden.map(({ path }) => path).join(', ')}`);
  }
  if (previewPaths.length > limit) {
    problems.push(
      `the merge would touch ${previewPaths.length} files but the PR changes ${changedFiles} (allowed up to ${limit})`,
    );
  }
  if (previewPaths.length > LARGE_COMMIT_FILE_LIMIT) {
    problems.push(`${previewPaths.length} files exceeds the commit-safety limit of ${LARGE_COMMIT_FILE_LIMIT}`);
  }
  return { ok: problems.length === 0, problems, fileCount: previewPaths.length };
}

function makeGit(cwd, env) {
  return function git(args, { allowFailure = false } = {}) {
    const result = spawnSync('git', args, { cwd, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0 && !allowFailure) {
      throw new LandingError(`git ${args.join(' ')} failed:\n${(result.stderr || result.stdout).trim()}`);
    }
    return { stdout: result.stdout, stderr: result.stderr, status: result.status };
  };
}

export function defaultGh(prNumber, cwd) {
  const fields = 'number,state,isDraft,title,headRefOid,headRefName,headRepositoryOwner,baseRefName,changedFiles,url';
  const result = spawnSync('gh', ['pr', 'view', String(prNumber), '--json', fields], { cwd, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new LandingError(`gh pr view ${prNumber} failed:\n${result.stderr.trim()}`);
  return JSON.parse(result.stdout);
}

function mergeMessage(pr) {
  const owner = pr.headRepositoryOwner?.login ?? 'contributor';
  return [`Merge pull request #${pr.number} from ${owner}/${pr.headRefName}`, pr.title];
}

/**
 * Prove HEAD is a two-parent merge of `previousTip` and `prHead` whose
 * first-parent diff is within the PR's size. Shared by the normal path and
 * `--verify` after a manual conflict resolution.
 */
export function verifyMergeShape({ git, prHead, changedFiles, previousTip }) {
  const parents = git(['rev-list', '--parents', '-n', '1', 'HEAD']).stdout.trim().split(/\s+/).slice(1);
  if (parents.length !== 2) {
    throw new LandingError(`HEAD has ${parents.length} parent(s); a landed PR is a two-parent merge commit.`);
  }
  if (parents[1] !== prHead) {
    throw new LandingError(`HEAD^2 is ${parents[1]}, expected the PR head ${prHead}.`);
  }
  if (previousTip && parents[0] !== previousTip) {
    throw new LandingError(`HEAD^1 is ${parents[0]}, expected the previous main tip ${previousTip}.`);
  }
  const paths = splitNul(git(['diff-tree', '-r', '--no-commit-id', '--name-only', '-z', parents[0], 'HEAD']).stdout);
  const result = evaluatePreview({ previewPaths: paths, changedFiles });
  if (!result.ok) {
    throw new LandingError(`the merge commit at HEAD has the wrong shape: ${result.problems.join('; ')}`);
  }
  return { parents, fileCount: paths.length };
}

/**
 * Land PR `prNumber`. `gh` is injectable so tests can run against a local
 * bare remote with a fabricated PR record. Returns a summary; throws
 * LandingError with an actionable message on any refusal.
 */
export function landPr({ prNumber, cwd = process.cwd(), env = process.env, gh = defaultGh, dryRun = false, verify = false, log = console.log }) {
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new LandingError('usage: node scripts/land-pr.mjs <PR number or URL> [--dry-run | --verify]');
  }
  const git = makeGit(cwd, env);
  const say = (message) => log(`[land-pr] ${message}`);

  const pr = gh(prNumber, cwd);
  say(`PR #${pr.number}: ${pr.title} (${pr.headRefName} @ ${pr.headRefOid.slice(0, 9)}, ${pr.changedFiles} files)`);
  if (pr.baseRefName !== REQUIRED_BASE_BRANCH) {
    throw new LandingError(`PR #${pr.number} targets ${pr.baseRefName}, not ${REQUIRED_BASE_BRANCH}.`);
  }

  if (verify) {
    const shape = verifyMergeShape({ git, prHead: pr.headRefOid, changedFiles: pr.changedFiles });
    say(`HEAD is a merge of ${shape.parents[0].slice(0, 9)} and the PR head; ${shape.fileCount} files vs first parent. OK.`);
    say('Next: run the gate, then `git push origin main`.');
    return { ok: true, verified: true };
  }

  if (pr.state !== 'OPEN') throw new LandingError(`PR #${pr.number} is ${pr.state}; only open PRs can be landed.`);
  if (pr.isDraft) throw new LandingError(`PR #${pr.number} is a draft.`);

  const branch = git(['symbolic-ref', '--short', '-q', 'HEAD'], { allowFailure: true }).stdout.trim();
  if (branch !== REQUIRED_BASE_BRANCH) {
    throw new LandingError(`the checkout is on '${branch || '(detached)'}'; land only from ${REQUIRED_BASE_BRANCH}. Do not check out the PR branch.`);
  }
  const staged = splitNul(git(['diff', '--cached', '--name-only', '-z']).stdout);
  if (staged.length > 0) {
    throw new LandingError(`the index already has staged changes (${staged.length}); commit or unstage them first.`);
  }
  if (git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { allowFailure: true }).status === 0) {
    throw new LandingError('a merge is already in progress; finish it or `git merge --abort` first.');
  }

  say('Fetching origin/main and the PR head...');
  git(['fetch', '--quiet', 'origin', REQUIRED_BASE_BRANCH]);
  git(['fetch', '--quiet', 'origin', `pull/${pr.number}/head`]);
  const fetchedHead = git(['rev-parse', 'FETCH_HEAD']).stdout.trim();
  if (fetchedHead !== pr.headRefOid) {
    throw new LandingError(`fetched PR head ${fetchedHead} does not match GitHub's ${pr.headRefOid}; the PR moved. Re-review before landing.`);
  }
  const prHead = pr.headRefOid;
  const originMain = git(['rev-parse', `origin/${REQUIRED_BASE_BRANCH}`]).stdout.trim();

  if (git(['merge-base', '--is-ancestor', prHead, 'HEAD'], { allowFailure: true }).status === 0) {
    say(`PR head ${prHead.slice(0, 9)} is already contained in main; nothing to land.`);
    return { ok: true, alreadyLanded: true };
  }

  // Local main must contain origin/main. Behind: fast-forward (a dry run only
  // reports it and previews against origin/main). Diverged: stop.
  let previousTip = git(['rev-parse', 'HEAD']).stdout.trim();
  const localHasOrigin = git(['merge-base', '--is-ancestor', originMain, 'HEAD'], { allowFailure: true }).status === 0;
  if (!localHasOrigin) {
    const originHasLocal = git(['merge-base', '--is-ancestor', 'HEAD', originMain], { allowFailure: true }).status === 0;
    if (!originHasLocal) {
      throw new LandingError(`local ${REQUIRED_BASE_BRANCH} has diverged from origin/${REQUIRED_BASE_BRANCH}; reconcile it by hand before landing.`);
    }
    if (dryRun) {
      say(`Dry run: ${REQUIRED_BASE_BRANCH} is behind origin/${REQUIRED_BASE_BRANCH}; a real run would fast-forward it first.`);
    } else {
      say(`Fast-forwarding ${REQUIRED_BASE_BRANCH} to origin/${REQUIRED_BASE_BRANCH} (${originMain.slice(0, 9)})...`);
      git(['merge', '--ff-only', '--quiet', originMain]);
    }
    previousTip = dryRun ? originMain : git(['rev-parse', 'HEAD']).stdout.trim();
  }

  // The merge base must sit on origin/main, so the PR's own diff is exactly
  // what main gains. A base off some other branch means the PR history is
  // not rooted in main and the preview below would be meaningless.
  const mergeBase = git(['merge-base', previousTip, prHead]).stdout.trim();
  if (git(['merge-base', '--is-ancestor', mergeBase, originMain], { allowFailure: true }).status !== 0) {
    throw new LandingError(`merge base ${mergeBase.slice(0, 9)} is not on origin/${REQUIRED_BASE_BRANCH}.`);
  }

  // Every commit the PR brings in must be a plain commit. A merge inside the
  // PR means the contributor merged main (or something else) into the branch;
  // GitHub renders it against its first parent and it drags that whole diff
  // into main's history.
  const prCommits = git(['rev-list', '--parents', `${previousTip}..${prHead}`]).stdout.trim().split('\n').filter(Boolean)
    .map((line) => line.split(/\s+/));
  const mergesInPr = prCommits.filter((fields) => fields.length > 2).map((fields) => fields[0]);
  if (mergesInPr.length > 0) {
    throw new LandingError(
      `the PR contains merge commits (${mergesInPr.map((sha) => sha.slice(0, 9)).join(', ')}). ` +
      'Ask the contributor to rebase onto main, or land only the non-merge commits by hand after the maintainer decides.',
    );
  }

  const previewPaths = splitNul(git(['diff', '--name-only', '-z', mergeBase, prHead]).stdout);
  const preview = evaluatePreview({ previewPaths, changedFiles: pr.changedFiles });
  say(`Preview: ${prCommits.length} commit(s), ${preview.fileCount} file(s) from merge base ${mergeBase.slice(0, 9)}.`);
  if (!preview.ok) throw new LandingError(`refusing to merge: ${preview.problems.join('; ')}`);

  const dirty = splitNul(git(['diff', '--name-only', '-z']).stdout);
  const overlap = dirty.filter((path) => previewPaths.includes(path));
  if (overlap.length > 0) {
    throw new LandingError(`the PR touches files with uncommitted local changes: ${overlap.join(', ')}. Commit or move them first.`);
  }

  if (dryRun) {
    say('Dry run: stopping before the merge.');
    return { ok: true, dryRun: true, previewPaths, previousTip, prHead };
  }

  const [subject, body] = mergeMessage(pr);
  say(`Merging ${prHead.slice(0, 9)} into ${REQUIRED_BASE_BRANCH} with --no-ff...`);
  const merge = git(['merge', '--no-ff', '--no-edit', '-m', subject, '-m', body, prHead], { allowFailure: true });
  if (merge.status !== 0) {
    const conflicted = splitNul(git(['diff', '--name-only', '-z', '--diff-filter=U']).stdout);
    if (conflicted.length === 0) {
      throw new LandingError(`git merge failed:\n${(merge.stderr || merge.stdout).trim()}`);
    }
    throw new LandingError(
      `merge conflicts in: ${conflicted.join(', ')}.\n` +
      'Resolve them in place, `git add` each file, run `git commit` (the prepared message is kept),\n' +
      `then run \`node scripts/land-pr.mjs ${pr.number} --verify\` before pushing.`,
    );
  }
  const shape = verifyMergeShape({ git, prHead, changedFiles: pr.changedFiles, previousTip });
  const mergeSha = git(['rev-parse', 'HEAD']).stdout.trim();
  say(`Merged as ${mergeSha.slice(0, 9)} (${shape.fileCount} files vs ${previousTip.slice(0, 9)}).`);
  say('Not pushing. Apply maintainer fixes as separate commits, run the gate, then `git push origin main`.');
  return { ok: true, mergeSha, previousTip, prHead, fileCount: shape.fileCount };
}

function main() {
  const { prNumber, dryRun, verify } = parseArgs(process.argv.slice(2));
  try {
    landPr({ prNumber, dryRun, verify });
  } catch (error) {
    if (error instanceof LandingError) {
      console.error(`[land-pr] ERROR: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

// pathToFileURL, not a `file://` template: process.argv[1] is a backslashed
// drive path on Windows while import.meta.url is forward-slashed.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
