/**
 * Main-process uncaught-exception handler.
 *
 * Extracted from bootstrap.ts so the throttling and the EPIPE guard can be
 * unit tested. Registered once in bootstrap.ts via
 * `process.on('uncaughtException', createUncaughtExceptionHandler())`.
 *
 * The handler logs the error, suppresses duplicate errors within a short
 * window, and caps the error-dialog rate.
 *
 * It also guards against the EPIPE feedback loop reported in #502: on Linux a
 * broken main-process stderr pipe (the launcher detaches, journald reconnects)
 * makes every console.* write throw EPIPE. Logging that EPIPE through the same
 * console transport throws again and re-enters this handler in a tight loop
 * (the reported incident logged 7,203 EPIPE pairs in roughly 3ms before the
 * process died). EPIPE errors are dropped without touching the console, so the
 * loop cannot start.
 */
import { dialog } from 'electron';

const ERROR_THROTTLE_MS = 5000; // suppress duplicate errors within this window
const MAX_DIALOGS_PER_MINUTE = 3;

/** OS limits on descriptors or watches; a watcher hitting one loses change events, nothing more. */
const WATCH_LIMIT_CODES = new Set(['EMFILE', 'ENFILE', 'ENOSPC']);

type UncaughtError = Error & { code?: string; syscall?: string };

export function createUncaughtExceptionHandler(): (error: UncaughtError) => void {
  const recentErrors = new Map<string, number>(); // error key -> timestamp
  let dialogTimestamps: number[] = [];

  return function handleUncaughtException(error: UncaughtError): void {
    // EPIPE feedback-loop guard (#502). A broken stderr pipe makes console.*
    // throw EPIPE; logging an EPIPE through the console transport below would
    // throw again and re-enter this handler in a loop. There is nothing
    // actionable to surface for a broken stderr pipe, so drop it.
    if (error.code === 'EPIPE') {
      return;
    }

    // An fs.watch handle with no 'error' listener that hits the descriptor or
    // watch limit lands here (#1779). showErrorBox is modal and blocks the main
    // process, so with many projects restored at launch the dialogs kept the
    // app from starting. Log it and keep running without that watcher.
    // This also matches a synchronous fs.watch() failure that no caller caught.
    // Node gives both the same code/syscall; only the internal stack frame
    // differs, and keying on that would silently bring the blocking dialog back
    // if Node renamed it. Suppression is safe there too: the throw has already
    // unwound its caller, the error is still logged, and a modal adds nothing.
    if (error.syscall === 'watch' && error.code && WATCH_LIMIT_CODES.has(error.code)) {
      console.error('[Bootstrap] File watcher hit an OS limit; continuing without it:', error);
      return;
    }

    // Known Claude Agent SDK stream error (write after stdin closed). Log it,
    // but don't show a dialog.
    if (error.code === 'ERR_STREAM_WRITE_AFTER_END' && error.stack?.includes('claude-agent-sdk')) {
      console.warn('[Bootstrap] Suppressed Claude Agent SDK stream error:', error.message);
      return;
    }

    // Always log the error.
    console.error('[Bootstrap] Uncaught exception:', error);

    const now = Date.now();
    const errorKey = `${error.name}:${error.message}`;

    // Suppress duplicate errors within the throttle window.
    const lastSeen = recentErrors.get(errorKey);
    if (lastSeen && now - lastSeen < ERROR_THROTTLE_MS) {
      console.warn('[Bootstrap] Suppressed duplicate error dialog:', errorKey);
      return;
    }
    recentErrors.set(errorKey, now);

    // Clean up old entries.
    for (const [key, ts] of recentErrors) {
      if (now - ts > ERROR_THROTTLE_MS) recentErrors.delete(key);
    }

    // Cap total dialogs per minute.
    dialogTimestamps = dialogTimestamps.filter((ts) => now - ts < 60_000);
    if (dialogTimestamps.length >= MAX_DIALOGS_PER_MINUTE) {
      console.warn('[Bootstrap] Too many error dialogs, suppressing. Error:', errorKey);
      return;
    }
    dialogTimestamps.push(now);

    dialog.showErrorBox(
      'Nimbalyst - Uncaught Exception',
      `${error.name}: ${error.message}\n\n${error.stack || ''}`,
    );
  };
}
