// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const showErrorBox = vi.fn();
vi.mock('electron', () => ({
  dialog: { showErrorBox: (...args: unknown[]) => showErrorBox(...args) },
}));

import { createUncaughtExceptionHandler } from '../uncaughtException';

describe('createUncaughtExceptionHandler', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    showErrorBox.mockReset();
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('drops EPIPE errors without touching the console (breaks the #502 feedback loop)', () => {
    const handle = createUncaughtExceptionHandler();
    const epipe = Object.assign(new Error('write EPIPE'), { name: 'Error', code: 'EPIPE' });

    handle(epipe);

    // The loop only starts if the handler writes to the (broken) console. For
    // an EPIPE it must not call console.error / console.warn or show a dialog.
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(showErrorBox).not.toHaveBeenCalled();
  });

  it('logs and shows a dialog for a normal uncaught error', () => {
    const handle = createUncaughtExceptionHandler();
    const err = Object.assign(new Error('boom'), { name: 'TypeError' });

    handle(err);

    expect(errorSpy).toHaveBeenCalledWith('[Bootstrap] Uncaught exception:', err);
    expect(showErrorBox).toHaveBeenCalledTimes(1);
  });

  // #1779: an fs.watch handle that hits the descriptor limit emits 'error' from
  // FSWatcher._handle.onchange; with no listener that lands here. A modal error
  // box per watcher blocked startup with many restored projects. Watching is a
  // degraded feature, not a crash: log it, never block on a dialog.
  it('logs watcher resource-exhaustion errors without a blocking dialog', () => {
    const handle = createUncaughtExceptionHandler();
    const emfile = Object.assign(new Error('EMFILE: too many open files, watch'), {
      code: 'EMFILE',
      syscall: 'watch',
    });

    handle(emfile);
    handle(Object.assign(new Error('ENOSPC: System limit for number of file watchers reached, watch'), {
      code: 'ENOSPC',
      syscall: 'watch',
    }));

    expect(showErrorBox).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('watcher'), emfile);
  });

  it('still shows a dialog for EMFILE outside a watcher', () => {
    const handle = createUncaughtExceptionHandler();

    handle(Object.assign(new Error('EMFILE: too many open files, open'), { code: 'EMFILE', syscall: 'open' }));

    expect(showErrorBox).toHaveBeenCalledTimes(1);
  });

  it('suppresses a duplicate error dialog within the throttle window', () => {
    const handle = createUncaughtExceptionHandler();
    const err = Object.assign(new Error('dup'), { name: 'Error' });

    handle(err);
    handle(err);

    expect(showErrorBox).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith('[Bootstrap] Suppressed duplicate error dialog:', 'Error:dup');
  });
});
