import * as path from 'path';
import * as fs from 'fs';
import type { SimpleGit } from 'simple-git';
import { simpleGitReadOnly } from '../services/gitReadOnly';
import { BrowserWindow } from 'electron';
import { logger } from '../utils/logger';
import { clearGitStatusCache } from '../ipc/GitStatusHandlers';
import { clearGitFactsCache } from '../utils/gitUncommittedFiles';

type NativeFileWatchListener = (curr: fs.Stats, prev: fs.Stats) => void;

interface NativeFileWatcher {
  filePath: string;
  listener: NativeFileWatchListener;
}

interface PendingWatcherStart {
  cancelled: boolean;
  promise: Promise<void>;
}

interface WatcherEntry {
  refWatcher: NativeFileWatcher;
  indexWatcher: NativeFileWatcher;
  headWatcher: NativeFileWatcher;
  lastCommitHash: string;
  currentBranch: string;
  /** Where refs/heads lives — the shared parent dir for a worktree. */
  commonDir: string;
  git: SimpleGit;
  /**
   * The workspace this repo was registered under, which is not the repo path
   * once a project spans several folders. Git status is routed by repo, but
   * pending reviews are workspace-scoped, so the two must not be conflated.
   */
  owningWorkspace: string;
}

/**
 * Payload emitted when a new commit is detected on the current branch.
 * Available to both main-process subscribers (via onCommitDetected) and
 * renderer windows (via IPC 'git:commit-detected').
 */
export interface CommitDetectedEvent {
  workspacePath: string;
  commitHash: string;
  commitMessage: string;
  committedFiles: string[];
}

export type CommitDetectedListener = (event: CommitDetectedEvent) => void | Promise<void>;

interface GitDirInfo {
  /** The git directory for this workspace (worktree-specific for worktrees) */
  gitDir: string;
  /** The common git directory where refs/heads are stored (same as gitDir for regular repos) */
  commonDir: string;
}

const GIT_FILE_WATCH_INTERVAL_MS = 500;

function statsRepresentExistingFile(stats: fs.Stats): boolean {
  return stats.nlink > 0 || stats.mtimeMs > 0 || stats.ctimeMs > 0 || stats.size > 0;
}

function statsChanged(curr: fs.Stats, prev: fs.Stats): boolean {
  return (
    curr.mtimeMs !== prev.mtimeMs ||
    curr.ctimeMs !== prev.ctimeMs ||
    curr.size !== prev.size ||
    curr.ino !== prev.ino ||
    curr.nlink !== prev.nlink
  );
}

function watchGitFile(
  filePath: string,
  onChange: (created: boolean) => void | Promise<void>,
  onError: (error: unknown) => void,
): NativeFileWatcher {
  const listener: NativeFileWatchListener = (curr, prev) => {
    try {
      if (!statsChanged(curr, prev)) return;
      const currExists = statsRepresentExistingFile(curr);
      const prevExists = statsRepresentExistingFile(prev);
      if (!currExists && !prevExists) return;
      void Promise.resolve(onChange(currExists && !prevExists)).catch(onError);
    } catch (error) {
      onError(error);
    }
  };

  fs.watchFile(filePath, {
    interval: GIT_FILE_WATCH_INTERVAL_MS,
    persistent: false,
  }, listener);

  return { filePath, listener };
}

function unwatchGitFile(watcher: NativeFileWatcher): void {
  fs.unwatchFile(watcher.filePath, watcher.listener);
}

/**
 * Resolve the git directories for a workspace.
 * In regular repos, both gitDir and commonDir are workspacePath/.git
 * In worktrees, gitDir is the worktree-specific dir, commonDir is the shared parent
 *
 * @param workspacePath - The workspace path to check
 * @returns GitDirInfo with both directories, or null if not a git repo
 */
async function resolveGitDirs(workspacePath: string): Promise<GitDirInfo | null> {
  const gitPath = path.join(workspacePath, '.git');

  try {
    const stat = await fs.promises.stat(gitPath);

    if (stat.isDirectory()) {
      // Regular git repository - gitDir and commonDir are the same
      return { gitDir: gitPath, commonDir: gitPath };
    }

    if (stat.isFile()) {
      // Worktree - .git is a file containing the gitdir path
      const content = await fs.promises.readFile(gitPath, 'utf-8');
      const match = content.match(/^gitdir:\s*(.+)$/m);
      if (match) {
        let gitDir = match[1].trim();
        // The gitdir path may be relative or absolute
        if (!path.isAbsolute(gitDir)) {
          gitDir = path.resolve(workspacePath, gitDir);
        }

        // For worktrees, the commondir is in the gitDir/commondir file
        // This points to the shared .git directory where refs/heads are stored
        const commonDirFile = path.join(gitDir, 'commondir');
        try {
          const commonDirContent = await fs.promises.readFile(commonDirFile, 'utf-8');
          let commonDir = commonDirContent.trim();
          if (!path.isAbsolute(commonDir)) {
            commonDir = path.resolve(gitDir, commonDir);
          }
          return { gitDir, commonDir };
        } catch {
          // No commondir file - fall back to gitDir
          return { gitDir, commonDir: gitDir };
        }
      }
    }
  } catch {
    // Not a git repository or file doesn't exist
  }

  return null;
}

/**
 * GitRefWatcher watches .git/refs/heads/<branch> and .git/index to detect all git operations.
 *
 * This provides real-time git status updates by detecting:
 * - Commits (via .git/refs/heads/<branch> changes)
 * - Staging changes (via .git/index changes)
 *
 * When commits are detected, it auto-approves pending reviews for committed files.
 */
export class GitRefWatcher {
  // Map<workspacePath, WatcherEntry>
  private watchers = new Map<string, WatcherEntry>();
  private pendingStarts = new Map<string, PendingWatcherStart>();
  private workspaceOwners = new Map<string, Set<string>>();

  // Debounce index changes to avoid rapid fire during staging operations
  private indexDebounceTimers = new Map<string, NodeJS.Timeout>();
  private readonly INDEX_DEBOUNCE_MS = 100;

  // Main-process commit event listeners
  private commitListeners = new Set<CommitDetectedListener>();

  /**
   * Subscribe to commit events from the main process.
   * Use this instead of IPC when you need to react to commits
   * in a main-process service (e.g., CommitTrackerLinker).
   */
  onCommitDetected(listener: CommitDetectedListener): void {
    this.commitListeners.add(listener);
  }

  /**
   * Unsubscribe from commit events.
   */
  offCommitDetected(listener: CommitDetectedListener): void {
    this.commitListeners.delete(listener);
  }

  /**
   * Start watching a repo for git state changes.
   *
   * `owningWorkspace` is the workspace this repo was registered under. It
   * differs from `workspacePath` whenever the repo lives in an attached folder
   * or below a container root, and it is what pending-review updates must be
   * attributed to. Defaults to the repo itself for single-root callers.
   * `projectPath` tracks lifetime separately: worktree review events still use
   * the worktree path, while closing its parent project releases its watcher.
   */
  async start(workspacePath: string, owningWorkspace?: string, projectPath = owningWorkspace ?? workspacePath): Promise<void> {
    const owners = this.workspaceOwners.get(workspacePath) ?? new Set<string>();
    owners.add(projectPath);
    this.workspaceOwners.set(workspacePath, owners);
    // Already watching this workspace
    if (this.watchers.has(workspacePath)) {
      logger.main.debug('[GitRefWatcher] Already watching workspace:', path.basename(workspacePath));
      return;
    }

    const pending = this.pendingStarts.get(workspacePath);
    if (pending) return pending.promise;

    // Publish before the first filesystem/Git await so concurrent callers
    // share one startup and stop() can retire it before handles exist.
    const startup: PendingWatcherStart = { cancelled: false, promise: Promise.resolve() };
    this.pendingStarts.set(workspacePath, startup);
    startup.promise = this.startWatching(workspacePath, owningWorkspace, startup).finally(() => {
      if (this.pendingStarts.get(workspacePath) === startup) {
        this.pendingStarts.delete(workspacePath);
      }
    });
    return startup.promise;
  }

  private async startWatching(
    workspacePath: string,
    owningWorkspace: string | undefined,
    startup: PendingWatcherStart,
  ): Promise<void> {
    try {
      // Resolve the git directories (handles worktrees where .git is a file)
      const gitDirs = await resolveGitDirs(workspacePath);
      if (startup.cancelled) return;

      if (!gitDirs) {
        // Not a git repository
        logger.main.debug('[GitRefWatcher] Not a git repository:', path.basename(workspacePath));
        return;
      }

      const { gitDir, commonDir } = gitDirs;

      // HEAD moves on every rebase step; this status must not lock the index.
      const git: SimpleGit = simpleGitReadOnly(workspacePath);

      // Pre-flight: get current branch + HEAD hash. Both can fail on a
      // fresh-init repo with zero commits ("fatal: your current branch X
      // does not have any commits yet"). Treat that as a known no-op rather
      // than logging the full stack trace, mirroring the detached-HEAD
      // short-circuit below.
      let currentBranch: string;
      let lastCommitHash: string;
      try {
        const status = await git.status();
        if (startup.cancelled) return;
        if (!status.current) {
          // Not on a branch (detached HEAD) - skip watching
          logger.main.info('[GitRefWatcher] Skipping detached HEAD workspace:', workspacePath);
          return;
        }
        currentBranch = status.current;

        const log = await git.log({ maxCount: 1 });
        if (startup.cancelled) return;
        lastCommitHash = log.latest?.hash || '';
      } catch (preflightError) {
        const msg = preflightError instanceof Error
          ? preflightError.message
          : String(preflightError);
        if (/does not have any commits yet/i.test(msg)) {
          logger.main.info(
            '[GitRefWatcher] Skipping workspace with no commits yet:',
            path.basename(workspacePath),
          );
          return;
        }
        throw preflightError;
      }

      // Watch refs/heads/<current-branch> for commit detection
      // Use commonDir for refs (in worktrees, refs are in the shared parent .git dir)
      const branchRefPath = path.join(commonDir, 'refs/heads', currentBranch);
      const refWatcher = watchGitFile(
        branchRefPath,
        async (created) => {
          if (created) {
            logger.main.info('[GitRefWatcher] Ref file added:', {
              workspace: path.basename(workspacePath),
              branch: currentBranch,
            });
          }
          await this.handleRefChange(workspacePath);
        },
        (error) => {
          logger.main.error('[GitRefWatcher] Ref watcher error:', error);
        },
      );

      // Watch index for staging changes
      // Use the resolved gitDir for the actual index file location
      const indexPath = path.join(gitDir, 'index');
      const indexWatcher = watchGitFile(
        indexPath,
        () => {
          this.handleIndexChangeDebounced(workspacePath);
        },
        (error) => {
          logger.main.error('[GitRefWatcher] Index watcher error:', error);
        },
      );

      // Watch HEAD for branch switches. Without this the ref watcher above
      // stays pinned to whichever branch was current at start(), so after a
      // checkout no commit on the new branch is ever detected — no
      // auto-approve, no `git:commit-detected`, no cache invalidation (#1403).
      const headPath = path.join(gitDir, 'HEAD');
      const headWatcher = watchGitFile(
        headPath,
        async () => {
          await this.handleHeadChange(workspacePath);
        },
        (error) => {
          logger.main.error('[GitRefWatcher] HEAD watcher error:', error);
        },
      );

      this.watchers.set(workspacePath, {
        refWatcher,
        indexWatcher,
        headWatcher,
        lastCommitHash,
        currentBranch,
        commonDir,
        git,
        owningWorkspace: owningWorkspace ?? workspacePath,
      });

      logger.main.info('[GitRefWatcher] Started watching:', {
        workspace: path.basename(workspacePath),
        branch: currentBranch,
        // Log if using worktree (gitDir != commonDir means refs are in a different location)
        isWorktree: gitDir !== commonDir ? true : undefined,
      });
    } catch (error) {
      logger.main.error('[GitRefWatcher] Failed to start watching:', error);
    }
  }

  /**
   * Stop watching a workspace
   */
  async stop(workspacePath: string): Promise<void> {
    this.workspaceOwners.delete(workspacePath);
    const pending = this.pendingStarts.get(workspacePath);
    if (pending) {
      pending.cancelled = true;
      this.pendingStarts.delete(workspacePath);
    }
    const entry = this.watchers.get(workspacePath);
    if (entry) {
      unwatchGitFile(entry.refWatcher);
      unwatchGitFile(entry.indexWatcher);
      unwatchGitFile(entry.headWatcher);
      this.watchers.delete(workspacePath);

      // Clear any pending debounce timer
      const timer = this.indexDebounceTimers.get(workspacePath);
      if (timer) {
        clearTimeout(timer);
        this.indexDebounceTimers.delete(workspacePath);
      }

      logger.main.info('[GitRefWatcher] Stopped watching:', path.basename(workspacePath));
    }
  }

  /** Release active and pending watchers with no remaining consumer. */
  async pruneUnused(isNeeded: (repoPath: string, owners: ReadonlySet<string>) => boolean): Promise<void> {
    const stops: Promise<void>[] = [];
    for (const [repoPath, owners] of this.workspaceOwners) {
      if (!isNeeded(repoPath, owners)) stops.push(this.stop(repoPath));
    }
    await Promise.all(stops);
  }

  /**
   * Stop watching all workspaces
   */
  async stopAll(): Promise<void> {
    logger.main.info(`[GitRefWatcher] Stopping all watchers (${this.watchers.size} active)`);

    const promises: Promise<void>[] = [];
    for (const workspacePath of new Set([...this.watchers.keys(), ...this.pendingStarts.keys(), ...this.workspaceOwners.keys()])) {
      promises.push(this.stop(workspacePath));
    }
    await Promise.all(promises);

    logger.main.info('[GitRefWatcher] All watchers stopped');
  }

  /**
   * Handle .git/refs/heads/<branch> file changes (new commits)
   */
  private async handleRefChange(workspacePath: string): Promise<void> {
    try {
      const entry = this.watchers.get(workspacePath);
      if (!entry) return;

      // Get the latest commit
      const log = await entry.git.log({ maxCount: 1 });
      if (!log.latest) return;

      const newCommitHash = log.latest.hash;

      // If this is the same commit we already processed, skip
      if (entry.lastCommitHash === newCommitHash) {
        return;
      }

      // logger.main.info('[GitRefWatcher] New commit detected:', {
      //   workspace: path.basename(workspacePath),
      //   hash: newCommitHash.slice(0, 7),
      //   message: log.latest.message?.substring(0, 50),
      // });

      // Update our tracking
      const oldCommitHash = entry.lastCommitHash;
      entry.lastCommitHash = newCommitHash;

      // Get the files that were changed in this commit
      let committedFiles: string[] = [];
      try {
        // Handle initial commit case (no parent)
        const diffRef = oldCommitHash ? `${oldCommitHash}..${newCommitHash}` : newCommitHash;
        const diffSummary = await entry.git.diffSummary([diffRef]);
        committedFiles = diffSummary.files.map((file) =>
          path.join(workspacePath, file.file)
        );
      } catch (diffError) {
        // Fallback: just get the files from the latest commit
        try {
          const diffSummary = await entry.git.diffSummary([`${newCommitHash}~1`, newCommitHash]);
          committedFiles = diffSummary.files.map((file) =>
            path.join(workspacePath, file.file)
          );
        } catch {
          // Initial commit or other edge case - get files from show
          logger.main.warn('[GitRefWatcher] Could not get diff summary, skipping auto-approve');
        }
      }

      // logger.main.info('[GitRefWatcher] Committed files:', committedFiles.length);

      // Auto-approve pending reviews for committed files
      if (committedFiles.length > 0) {
        await this.autoApprovePendingReviews(workspacePath, committedFiles);
      }

      // Clear git status cache so next query gets fresh data
      clearGitStatusCache(workspacePath);
      clearGitFactsCache(workspacePath);

      // Notify main-process listeners (e.g., CommitTrackerLinker)
      const commitEvent: CommitDetectedEvent = {
        workspacePath,
        commitHash: newCommitHash,
        commitMessage: log.latest.message,
        committedFiles,
      };
      for (const listener of this.commitListeners) {
        try {
          Promise.resolve(listener(commitEvent)).catch((err) => {
            logger.main.error('[GitRefWatcher] Commit listener error:', err);
          });
        } catch (err) {
          logger.main.error('[GitRefWatcher] Commit listener error:', err);
        }
      }

      // Emit events to renderer windows for UI updates
      this.emitToAllWindows('git:commit-detected', commitEvent);

      this.emitToAllWindows('git:status-changed', {
        workspacePath,
        // The watcher is registered per repo, so this IS the repo root. Named
        // explicitly because a multi-root renderer routes on it: the repo may
        // sit inside an attached folder, not the workspace path.
        repoPath: workspacePath,
      });
    } catch (error) {
      logger.main.error('[GitRefWatcher] Error handling ref change:', error);
    }
  }

  /**
   * Handle .git/HEAD changes (branch switches).
   *
   * Re-points the branch-ref watcher at the new branch and refreshes cached git
   * facts. Deliberately does NOT run the auto-approve sweep: the files that
   * differ between two branch tips are not "files that were just committed",
   * and retiring their pending reviews on that basis would drop edits the user
   * never saw. Reconciliation on the read path handles those.
   */
  private async handleHeadChange(workspacePath: string): Promise<void> {
    try {
      const entry = this.watchers.get(workspacePath);
      if (!entry) return;

      const status = await entry.git.status();
      // A stop/restart may have retired this entry while Git was running.
      // Do not recreate a branch poller that no live entry can release.
      if (this.watchers.get(workspacePath) !== entry) return;
      // Detached HEAD (mid-rebase, bisect, checkout of a tag): nothing to
      // re-point at. Leave the existing watcher alone until HEAD names a branch
      // again.
      if (!status.current || status.current === entry.currentBranch) return;

      const previousBranch = entry.currentBranch;
      const branchRefPath = path.join(entry.commonDir, 'refs/heads', status.current);

      unwatchGitFile(entry.refWatcher);
      entry.refWatcher = watchGitFile(
        branchRefPath,
        async () => {
          await this.handleRefChange(workspacePath);
        },
        (error) => {
          logger.main.error('[GitRefWatcher] Ref watcher error:', error);
        },
      );
      entry.currentBranch = status.current;

      // Re-baseline the commit hash to the new branch tip, so the next commit
      // on it is detected as a delta from here rather than diffed against the
      // old branch.
      const log = await entry.git.log({ maxCount: 1 });
      if (this.watchers.get(workspacePath) !== entry) return;
      entry.lastCommitHash = log.latest?.hash || '';

      logger.main.info('[GitRefWatcher] Branch switch detected, re-pointed ref watcher:', {
        workspace: path.basename(workspacePath),
        from: previousBranch,
        to: status.current,
      });

      clearGitStatusCache(workspacePath);
      clearGitFactsCache(workspacePath);
      this.emitToAllWindows('git:status-changed', { workspacePath, repoPath: workspacePath });
    } catch (error) {
      logger.main.error('[GitRefWatcher] Error handling HEAD change:', error);
    }
  }

  /**
   * Handle .git/index changes with debouncing
   */
  private handleIndexChangeDebounced(workspacePath: string): void {
    // Clear existing timer
    const existingTimer = this.indexDebounceTimers.get(workspacePath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Set new timer
    const timer = setTimeout(() => {
      this.indexDebounceTimers.delete(workspacePath);
      this.handleIndexChange(workspacePath);
    }, this.INDEX_DEBOUNCE_MS);

    this.indexDebounceTimers.set(workspacePath, timer);
  }

  /**
   * Handle .git/index changes (staging changes)
   */
  private handleIndexChange(workspacePath: string): void {
    // Clear git status cache so next query gets fresh data
    clearGitStatusCache(workspacePath);
    clearGitFactsCache(workspacePath);

    // Emit event to update UI
    this.emitToAllWindows('git:status-changed', {
      workspacePath,
      // The watcher is registered per repo, so this IS the repo root. Named
      // explicitly because a multi-root renderer routes on it: the repo may
      // sit inside an attached folder, not the workspace path.
      repoPath: workspacePath,
    });
  }

  /**
   * Auto-approve pending reviews for committed files
   */
  private async autoApprovePendingReviews(
    workspacePath: string,
    committedFiles: string[],
    injectedHistoryManager?: Pick<
      typeof import('../HistoryManager').historyManager,
      'getPendingTags' | 'updateTagStatus'
    >,
  ): Promise<void> {
    try {
      const historyManager =
        injectedHistoryManager ?? (await import('../HistoryManager')).historyManager;

      // Pending reviews are workspace-scoped, but this watcher is keyed by repo.
      // `updateTagStatus`'s last argument becomes the key of the debounced
      // `history:pending-count-changed` broadcast, and the renderer matches
      // sessions on exact workspace equality -- so passing the repo root here
      // would silently drop the badge refresh for any repo that is not itself
      // the workspace root.
      const owningWorkspace =
        this.watchers.get(workspacePath)?.owningWorkspace ?? workspacePath;

      // logger.main.info('[GitRefWatcher] Auto-approving pending reviews for committed files:', {
      //   workspace: path.basename(workspacePath),
      //   fileCount: committedFiles.length,
      //   files: committedFiles.map(f => path.basename(f)),
      // });

      let approvedCount = 0;
      for (const filePath of committedFiles) {
        const pendingTags = await historyManager.getPendingTags(filePath);

        logger.main.debug('[GitRefWatcher] Checking file for pending tags:', {
          file: path.basename(filePath),
          fullPath: filePath,
          pendingTagCount: pendingTags.length,
        });

        if (pendingTags.length > 0) {
          // logger.main.info('[GitRefWatcher] Auto-approving pending review:', {
          //   file: path.basename(filePath),
          //   tags: pendingTags.length,
          //   tagIds: pendingTags.map(t => t.id),
          // });

          for (const tag of pendingTags) {
            await historyManager.updateTagStatus(filePath, tag.id, 'reviewed', owningWorkspace);
            approvedCount++;
          }
        }
      }

      if (approvedCount === 0) {
        logger.main.info('[GitRefWatcher] No pending reviews found for committed files');
      }
      // No explicit pending-count emit here: each updateTagStatus above schedules
      // a trailing-debounced broadcast in HistoryManager, which fires once after
      // this whole sweep settles with the final count. Emitting again would just
      // run a redundant ~100ms count scan.
    } catch (error) {
      logger.main.error('[GitRefWatcher] Error auto-approving pending reviews:', error);
    }
  }

  /**
   * Emit an event to all browser windows
   */
  private emitToAllWindows(channel: string, data: unknown): void {
    const windows = BrowserWindow.getAllWindows();
    for (const window of windows) {
      if (!window.isDestroyed()) {
        window.webContents.send(channel, data);
      }
    }
  }

  /**
   * Get statistics for debugging
   */
  getStats(): { type: string; activeWatchers: number; workspaces: string[] } {
    return {
      type: 'GitRefWatcher',
      activeWatchers: this.watchers.size,
      workspaces: Array.from(this.watchers.keys()).map((p) => path.basename(p)),
    };
  }
}

export const gitRefWatcher = new GitRefWatcher();
