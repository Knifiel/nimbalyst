import path from 'path';
import { existsSync } from 'fs';
import { simpleGitReadOnly } from '../services/gitReadOnly';

// ============================================================
// Git Status Cache
// Caches uncommitted file sets to avoid repeated git status calls
// when multiple components request session lists simultaneously.
// In-flight dedup so concurrent callers share one git status invocation.
// ============================================================
interface GitStatusCache {
    uncommittedFiles: Set<string>;
    timestamp: number;
}

const gitStatusCache = new Map<string, GitStatusCache>();
const gitStatusInFlight = new Map<string, Promise<Set<string>>>();
const GIT_STATUS_CACHE_TTL_MS = 5000; // 5 second cache

interface TrackedFilesCache {
    trackedFiles: Set<string>;
    timestamp: number;
}

const trackedFilesCache = new Map<string, TrackedFilesCache>();
const trackedFilesInFlight = new Map<string, Promise<Set<string>>>();
// Tracked-ness only moves on `git add`/`rm`/`checkout`, far slower than
// working-tree status, and the payload is the whole index (~500KB on this
// repo). Cache it longer than the status set, and let GitRefWatcher punch it
// out on ref/index changes rather than paying for a re-listing every 5s.
const TRACKED_FILES_CACHE_TTL_MS = 30000;

// Hard cap on `git status` so a hung git subprocess can never freeze the
// session list. On Windows a stale `.git/index.lock`, a credential-helper
// prompt, or antivirus scanning can leave `git status` hanging forever; the
// un-timed await pinned `sessionListLoadingAtom` true and the session-history
// panel showed a spinner that only an app restart cleared (issue #929).
const GIT_STATUS_TIMEOUT_MS = 8000;

/**
 * Reject with `message` if `promise` has not settled within `ms`. The
 * original promise is left with a no-op catch so a late rejection (e.g. the
 * git child being killed after the race is lost) does not surface as an
 * unhandled rejection.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
    });
    promise.catch(() => {});
    return Promise.race([promise, timeout]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

/**
 * Returns the set of uncommitted file paths for a workspace, cached for a few
 * seconds and de-duplicated across concurrent callers. The underlying
 * `git status` is bounded by {@link GIT_STATUS_TIMEOUT_MS}: a hung git
 * subprocess rejects instead of hanging, so callers (e.g. the `sessions:list`
 * IPC) can degrade to zero uncommitted counts rather than freezing forever.
 *
 * Avoids spawning git status multiple times in rapid succession.
 */
export async function getCachedUncommittedFiles(workspacePath: string): Promise<Set<string>> {
    // Non-git workspaces have no uncommitted files
    if (!existsSync(path.join(workspacePath, '.git'))) {
        return new Set();
    }

    const cached = gitStatusCache.get(workspacePath);
    if (cached && Date.now() - cached.timestamp < GIT_STATUS_CACHE_TTL_MS) {
        return cached.uncommittedFiles;
    }

    const inFlight = gitStatusInFlight.get(workspacePath);
    if (inFlight) return inFlight;

    const queryPromise = (async () => {
        // `timeout.block` aborts (and kills) the git child after N ms without
        // output, so a hung `git status` rejects instead of hanging. The
        // explicit withTimeout race is belt-and-suspenders in case the child
        // streams output but never exits.
        // GIT_OPTIONAL_LOCKS=0 is the environment equivalent of the
        // `--no-optional-locks` flag simple-git gives no way to pass. It keeps
        // this read-only status from refreshing (and so locking) `.git/index`,
        // where it would contend with concurrent git writers such as the commit
        // path (NIM-2285). The unsafe flags are required because supplying ANY
        // env makes simple-git scan it and refuse to spawn git when the user's
        // own environment contains GIT_EDITOR, GIT_PAGER and friends.
        const git = simpleGitReadOnly(workspacePath, { timeout: { block: GIT_STATUS_TIMEOUT_MS } });
        const status = await withTimeout(
            git.status(),
            GIT_STATUS_TIMEOUT_MS,
            `git status timed out after ${GIT_STATUS_TIMEOUT_MS}ms for ${workspacePath}`,
        );

        const uncommittedFiles = new Set([
            ...status.modified,
            ...status.created,
            ...status.not_added,
            ...status.deleted,
            ...status.renamed.map(r => r.to),
            ...status.staged
        ]);

        gitStatusCache.set(workspacePath, {
            uncommittedFiles,
            timestamp: Date.now()
        });

        return uncommittedFiles;
    })();

    gitStatusInFlight.set(workspacePath, queryPromise);
    try {
        return await queryPromise;
    } finally {
        gitStatusInFlight.delete(workspacePath);
    }
}

/**
 * Returns the set of workspace-relative paths git tracks, cached and
 * de-duplicated the same way as {@link getCachedUncommittedFiles}.
 *
 * This exists as the second half of the "did this AI edit land?" question
 * (#1403). A path missing from the uncommitted set means EITHER "tracked and
 * clean" OR "gitignored", and those need opposite answers: the first says the
 * edit landed and its pending-review baseline can be retired, the second says
 * nothing at all. Only the intersection — tracked AND not uncommitted — is
 * evidence.
 *
 * Returns an empty set for a non-repo. Callers must treat "empty" as "no
 * signal", never as "nothing is tracked".
 */
export async function getCachedTrackedFiles(workspacePath: string): Promise<Set<string>> {
    if (!existsSync(path.join(workspacePath, '.git'))) {
        return new Set();
    }

    const cached = trackedFilesCache.get(workspacePath);
    if (cached && Date.now() - cached.timestamp < TRACKED_FILES_CACHE_TTL_MS) {
        return cached.trackedFiles;
    }

    const inFlight = trackedFilesInFlight.get(workspacePath);
    if (inFlight) return inFlight;

    const queryPromise = (async () => {
        // Same env handling as the status query above: GIT_OPTIONAL_LOCKS=0 to
        // keep a read-only listing off `.git/index`, and the unsafe flags
        // because supplying ANY env makes simple-git scan it and refuse to
        // spawn when the user's own environment carries GIT_EDITOR and friends.
        const git = simpleGitReadOnly(workspacePath, { timeout: { block: GIT_STATUS_TIMEOUT_MS } });

        // -z so paths with spaces, quotes or non-ASCII bytes survive intact;
        // git otherwise quotes and escapes them and the set would miss entries.
        const raw = await withTimeout(
            git.raw(['ls-files', '-z']),
            GIT_STATUS_TIMEOUT_MS,
            `git ls-files timed out after ${GIT_STATUS_TIMEOUT_MS}ms for ${workspacePath}`,
        );

        const trackedFiles = new Set(raw.split('\0').filter(Boolean));

        trackedFilesCache.set(workspacePath, {
            trackedFiles,
            timestamp: Date.now(),
        });

        return trackedFiles;
    })();

    trackedFilesInFlight.set(workspacePath, queryPromise);
    try {
        return await queryPromise;
    } finally {
        trackedFilesInFlight.delete(workspacePath);
    }
}

/**
 * Drop cached git facts for a workspace (or all workspaces). Called when a ref
 * or the index moves, so the next reconciliation sees the new reality instead
 * of waiting out a TTL.
 */
export function clearGitFactsCache(workspacePath?: string): void {
    if (workspacePath) {
        gitStatusCache.delete(workspacePath);
        trackedFilesCache.delete(workspacePath);
        return;
    }
    gitStatusCache.clear();
    trackedFilesCache.clear();
}
