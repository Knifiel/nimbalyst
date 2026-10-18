// @vitest-environment node
/**
 * Every fs.watch handle MCPConfigService opens for a workspace must be closed
 * by stopWatchingWorkspaceConfig / cleanup. A workspace without `.mcp.json`
 * used to open a fresh directory watcher on every start (only the file watcher
 * was deduplicated), and the leaked handles accumulated until EMFILE (#1748).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import * as path from 'path';

interface FakeWatcher extends EventEmitter {
  target: string;
  close: ReturnType<typeof vi.fn>;
  listener: (eventType: string, filename: string | null) => void;
}

const created: FakeWatcher[] = [];
const existingFiles = new Set<string>();

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    watch: vi.fn((target: string, listener: FakeWatcher['listener']) => {
      if (path.basename(target) === '.mcp.json' && !existingFiles.has(target)) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, watch '${target}'`), { code: 'ENOENT' });
      }
      const watcher = new EventEmitter() as FakeWatcher;
      watcher.target = target;
      watcher.listener = listener;
      watcher.close = vi.fn();
      created.push(watcher);
      return watcher;
    }),
  };
});

vi.mock('../../utils/logger', () => {
  const channel = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { logger: new Proxy({}, { get: () => channel }) };
});

import { MCPConfigService } from '../MCPConfigService';

const WORKSPACE = path.join(path.sep, 'tmp', 'nim-mcp-watch-ws');
const MCP_JSON = path.join(WORKSPACE, '.mcp.json');

const openWatchers = () => created.filter((w) => w.close.mock.calls.length === 0);

describe('MCPConfigService workspace watcher lifecycle', () => {
  beforeEach(() => {
    created.length = 0;
    existingFiles.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not open a second directory watcher when started again without .mcp.json', () => {
    const service = new MCPConfigService();

    service.startWatchingWorkspaceConfig(WORKSPACE);
    service.startWatchingWorkspaceConfig(WORKSPACE);
    service.startWatchingWorkspaceConfig(WORKSPACE);

    expect(created.filter((w) => w.target === WORKSPACE)).toHaveLength(1);

    service.stopWatchingWorkspaceConfig(WORKSPACE);
    expect(openWatchers()).toEqual([]);
  });

  it('keeps one directory watcher and adds the file watcher when .mcp.json appears', () => {
    vi.useFakeTimers();
    const service = new MCPConfigService();

    service.startWatchingWorkspaceConfig(WORKSPACE);
    const [dirWatcher] = created;
    expect(dirWatcher.target).toBe(WORKSPACE);

    existingFiles.add(MCP_JSON);
    dirWatcher.listener('rename', '.mcp.json');
    vi.runAllTimers();

    expect(created.map((w) => w.target)).toEqual([WORKSPACE, MCP_JSON]);

    service.cleanup();
    expect(openWatchers()).toEqual([]);
  });

  // Node closes an fs.watch handle when it emits 'error'. A dead watcher left in
  // the dedupe map would make every later start a no-op, so .mcp.json creation
  // would never be noticed again.
  it('replaces a directory watcher that errored on the next start', () => {
    vi.useFakeTimers();
    const service = new MCPConfigService();

    service.startWatchingWorkspaceConfig(WORKSPACE);
    const [failed] = created;
    failed.emit('error', Object.assign(new Error('EMFILE: too many open files, watch'), { code: 'EMFILE' }));

    service.startWatchingWorkspaceConfig(WORKSPACE);
    const replacement = created[1];
    expect(replacement?.target).toBe(WORKSPACE);

    existingFiles.add(MCP_JSON);
    replacement.listener('rename', '.mcp.json');
    vi.runAllTimers();

    expect(created.map((w) => w.target)).toEqual([WORKSPACE, WORKSPACE, MCP_JSON]);

    service.stopWatchingWorkspaceConfig(WORKSPACE);
    expect(openWatchers()).toEqual([]);
  });

  it('replaces a .mcp.json watcher that errored on the next start', () => {
    existingFiles.add(MCP_JSON);
    const service = new MCPConfigService();

    service.startWatchingWorkspaceConfig(WORKSPACE);
    const failed = created.find((w) => w.target === MCP_JSON)!;
    failed.emit('error', Object.assign(new Error('EMFILE: too many open files, watch'), { code: 'EMFILE' }));

    service.startWatchingWorkspaceConfig(WORKSPACE);

    expect(created.filter((w) => w.target === MCP_JSON)).toHaveLength(2);
    expect(created.filter((w) => w.target === WORKSPACE)).toHaveLength(1);

    service.stopWatchingWorkspaceConfig(WORKSPACE);
    expect(openWatchers()).toEqual([]);
  });
});
