import { existsSync, watch as fsWatchSync } from 'node:fs';
import type { WatchFactory } from './types.js';

export function defaultWatchFactory(dir: string, onEvent: () => void): { close(): void } {
  const watcher = fsWatchSync(dir, { recursive: true }, () => onEvent());
  watcher.on('error', () => {
    // A vanished folder ends the watch; the next explicit call rescans.
  });
  return { close: () => watcher.close() };
}

/**
 * A recursive watch on macOS (FSEvents) starts asynchronously, and a change
 * made before it is live is never delivered: with 12 busy processes, up to 7 of
 * 30 writes made right after the watch opened went unreported. A few rescans
 * after a watch opens catch those; a rescan that finds nothing notifies no one.
 */
export const DEFAULT_WATCH_CATCH_UP_MS: readonly number[] = [250, 1000, 3000];

/**
 * Watches the wiki root and the project's types folder. The types folder
 * usually appears after the wiki does (setup defines types later), so until it
 * exists it is polled for; once it can be watched, `onEvent` fires so the new
 * types are read.
 */
export function watchWikiFolders(input: {
  root: string;
  typesDir: string | null;
  factory: WatchFactory;
  onEvent: () => void;
  pollMs: number;
  catchUpMs?: readonly number[];
}): { close(): void } {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const catchUp = () => {
    for (const ms of input.catchUpMs ?? DEFAULT_WATCH_CATCH_UP_MS) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        input.onEvent();
      }, ms);
      timer.unref?.();
      timers.add(timer);
    }
  };
  const handles = [input.factory(input.root, input.onEvent)];
  catchUp();
  let poll: ReturnType<typeof setInterval> | null = null;
  const typesDir = input.typesDir;
  const attachTypes = (): boolean => {
    if (!typesDir || !existsSync(typesDir)) return false;
    try {
      handles.push(input.factory(typesDir, input.onEvent));
      catchUp();
      return true;
    } catch {
      return false;
    }
  };
  if (typesDir && !attachTypes()) {
    poll = setInterval(() => {
      if (!attachTypes()) return;
      if (poll) clearInterval(poll);
      poll = null;
      input.onEvent();
    }, input.pollMs);
    poll.unref?.();
  }
  return {
    close: () => {
      if (poll) clearInterval(poll);
      poll = null;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const handle of handles) handle.close();
      handles.length = 0;
    },
  };
}
