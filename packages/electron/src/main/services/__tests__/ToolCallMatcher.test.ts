// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('jotai-family', () => ({ atomFamily: vi.fn() }));

vi.mock('../../database/PGLiteDatabaseWorker', () => ({
  database: {
    isInitialized: () => true,
    initialize: vi.fn(),
    query: vi.fn(),
    getEngine: vi.fn(() => 'pglite'),
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    main: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

const mockGetMultiSessionEvents = vi.fn();
vi.mock('@nimbalyst/runtime/storage/repositories/TranscriptMigrationRepository', () => ({
  TranscriptMigrationRepository: {
    hasService: () => false,
    getService: () => ({
      findToolCallByProviderId: vi.fn().mockResolvedValue(null),
      getMultiSessionEvents: mockGetMultiSessionEvents,
    }),
  },
}));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { TranscriptMigrationRepository } from '@nimbalyst/runtime/storage/repositories/TranscriptMigrationRepository';
import { database } from '../../database/PGLiteDatabaseWorker';
import { estimateSerializedBytes, DEFAULT_RESPONSE_BYTE_LIMIT } from '../../database/sqlite/worker/responseSizeGuard';
import { SQLiteDatabase } from '../../database/sqlite/SQLiteDatabase';
import { logger } from '../../utils/logger';
import { createPGLiteSessionFileStore } from '../PGLiteSessionFileStore';
import {
  RAW_TOOL_CALL_PAGE_SIZE,
  getMatchableToolCallWindows,
  getRawToolCallWindows,
  getRawToolCallWindowsMultiSession,
  parseToolCallWindows,
  scoreMatch,
  scoreWorkspaceFileEdit,
  toolCallMatcher,
  type ToolCallWindow,
} from '../ToolCallMatcher';

describe('ToolCallMatcher', () => {
  beforeEach(() => {
    (database.query as ReturnType<typeof vi.fn>).mockReset();
    mockGetMultiSessionEvents.mockReset();
  });

  describe('parseToolCallWindows', () => {
    const baseDate = new Date('2026-02-20T12:00:00Z');
    const SESSION_ID = 'test-session';

    it('should parse Write tool call with file_path argument', () => {
      const content = JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'mcp_tool_call',
          id: 'tool-123',
          server: 'nimbalyst',
          tool: 'Write',
          arguments: { file_path: '/workspace/src/index.ts' },
          result: { success: true },
        },
      });

      const windows = parseToolCallWindows(1, content, baseDate, SESSION_ID, '/workspace');

      expect(windows).toHaveLength(1);
      expect(windows[0].toolName).toBe('mcp__nimbalyst__Write');
      expect(windows[0].toolCallItemId).toBe('tool-123');
      expect(windows[0].argsText).toContain('index.ts');
      expect(windows[0].messageId).toBe(1);
    });

    it('should parse Edit tool call with filePath argument', () => {
      const content = JSON.stringify({
        type: 'item.started',
        item: {
          type: 'mcp_tool_call',
          id: 'tool-456',
          server: 'nimbalyst',
          tool: 'Edit',
          arguments: { filePath: '/workspace/src/app.tsx' },
        },
      });

      const windows = parseToolCallWindows(2, content, baseDate, SESSION_ID, '/workspace');

      expect(windows).toHaveLength(1);
      expect(windows[0].argsText).toContain('app.tsx');
    });

    it('should parse command_execution (Bash) tool call', () => {
      const content = JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'command_execution',
          id: 'cmd-789',
          command: 'printf "hello" > /workspace/output.txt',
          result: { exit_code: 0 },
        },
      });

      const windows = parseToolCallWindows(3, content, baseDate, SESSION_ID, '/workspace');

      expect(windows).toHaveLength(1);
      expect(windows[0].toolName).toBe('Bash');
      expect(windows[0].argsText).toContain('output.txt');
    });

    it('should parse file_change event with multiple files', () => {
      const content = JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'file_change',
          id: 'fc-001',
          changes: [
            { path: '/workspace/src/a.ts', kind: 'edit' },
            { path: '/workspace/src/b.ts', kind: 'create' },
          ],
          result: { status: 'completed' },
        },
      });

      const windows = parseToolCallWindows(4, content, baseDate, SESSION_ID, '/workspace');

      expect(windows).toHaveLength(1);
      expect(windows[0].toolName).toBe('file_change');
      expect(windows[0].argsText).toContain('a.ts');
      expect(windows[0].argsText).toContain('b.ts');
    });

    it('should prefer synthetic Codex editGroupId from raw message metadata', () => {
      const content = JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'file_change',
          id: 'item_3',
          changes: [
            { path: '/workspace/src/a.ts', kind: 'update' },
          ],
        },
      });

      const windows = parseToolCallWindows(
        12,
        content,
        baseDate,
        SESSION_ID,
        '/workspace',
        { editGroupId: 'nimtc|item_3|1700000000000|9' },
      );

      expect(windows).toHaveLength(1);
      expect(windows[0].toolCallItemId).toBe('item_3');
      expect(windows[0].toolUseId).toBe('nimtc|item_3|1700000000000|9');
    });

    it('should ignore non-synthetic editGroupId metadata', () => {
      const content = JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'file_change',
          id: 'item_7',
          changes: [
            { path: '/workspace/src/a.ts', kind: 'update' },
          ],
        },
      });

      const windows = parseToolCallWindows(
        13,
        content,
        baseDate,
        SESSION_ID,
        '/workspace',
        { editGroupId: 'item_7' },
      );

      expect(windows).toHaveLength(1);
      expect(windows[0].toolUseId).toBe('item_7');
    });

    it('should include output text from tool results', () => {
      const content = JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'command_execution',
          id: 'cmd-out',
          command: 'node build.js',
          aggregated_output: 'Written output to /workspace/dist/bundle.js successfully',
        },
      });

      const windows = parseToolCallWindows(5, content, baseDate, SESSION_ID, '/workspace');

      expect(windows).toHaveLength(1);
      expect(windows[0].outputText).toContain('bundle.js');
    });

    it('should return empty array for non-tool events', () => {
      const content = JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'message',
          content: 'Hello world',
        },
      });

      const windows = parseToolCallWindows(6, content, baseDate, SESSION_ID);

      expect(windows).toHaveLength(0);
    });

    it('should return empty array for invalid JSON', () => {
      const windows = parseToolCallWindows(7, 'not json', baseDate, SESSION_ID);
      expect(windows).toHaveLength(0);
    });

    it('should return empty array for text-only chunks', () => {
      const content = JSON.stringify({ type: 'text', content: 'Some text' });
      const windows = parseToolCallWindows(8, content, baseDate, SESSION_ID);
      expect(windows).toHaveLength(0);
    });

    it('should include bash command in argsText for sed -i', () => {
      const content = JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'command_execution',
          id: 'cmd-sed',
          command: "sed -i 's/foo/bar/' /workspace/config.json",
          result: { exit_code: 0 },
        },
      });

      const windows = parseToolCallWindows(9, content, baseDate, SESSION_ID, '/workspace');

      expect(windows).toHaveLength(1);
      expect(windows[0].argsText).toContain('config.json');
    });

    it('should include bash command in argsText for tee', () => {
      const content = JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'command_execution',
          id: 'cmd-tee',
          command: 'echo "data" | tee /workspace/log.txt',
          result: { exit_code: 0 },
        },
      });

      const windows = parseToolCallWindows(10, content, baseDate, SESSION_ID, '/workspace');

      expect(windows).toHaveLength(1);
      expect(windows[0].argsText).toContain('log.txt');
    });

    it('should include bash command in argsText for chained commands', () => {
      const content = JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'command_execution',
          id: 'cmd-chain',
          command: 'mkdir -p /workspace/out && cp /workspace/src/a.ts /workspace/out/a.ts',
          result: { exit_code: 0 },
        },
      });

      const windows = parseToolCallWindows(11, content, baseDate, SESSION_ID, '/workspace');

      expect(windows).toHaveLength(1);
      expect(windows[0].argsText).toContain('a.ts');
    });

    // ---------------------------------------------------------------
    // Raw Claude API format tests
    // ---------------------------------------------------------------

    it('should parse raw Claude API format with tool_use blocks', () => {
      const content = JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-opus-4-6',
          id: 'msg_01ABC',
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_01XYZ',
              name: 'Edit',
              input: {
                file_path: '/workspace/src/app.ts',
                old_string: 'foo',
                new_string: 'bar',
              },
            },
          ],
        },
      });

      const windows = parseToolCallWindows(20, content, baseDate, SESSION_ID, '/workspace');

      expect(windows).toHaveLength(1);
      expect(windows[0].toolName).toBe('Edit');
      expect(windows[0].toolCallItemId).toBe('toolu_01XYZ');
      expect(windows[0].toolUseId).toBe('toolu_01XYZ');
      expect(windows[0].argsText).toContain('app.ts');
    });

    it('should parse raw Claude API format with multiple tool_use blocks', () => {
      const content = JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_01AAA',
              name: 'Write',
              input: { file_path: '/workspace/a.ts', content: 'hello' },
            },
            {
              type: 'tool_use',
              id: 'toolu_01BBB',
              name: 'Write',
              input: { file_path: '/workspace/b.ts', content: 'world' },
            },
          ],
        },
      });

      const windows = parseToolCallWindows(21, content, baseDate, SESSION_ID, '/workspace');

      expect(windows).toHaveLength(2);
      expect(windows[0].toolCallItemId).toBe('toolu_01AAA');
      expect(windows[0].argsText).toContain('a.ts');
      expect(windows[1].toolCallItemId).toBe('toolu_01BBB');
      expect(windows[1].argsText).toContain('b.ts');
    });

    it('should ignore text blocks in raw Claude API format', () => {
      const content = JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Let me edit the file.' },
            {
              type: 'tool_use',
              id: 'toolu_01CCC',
              name: 'Edit',
              input: { file_path: '/workspace/c.ts', old_string: 'x', new_string: 'y' },
            },
          ],
        },
      });

      const windows = parseToolCallWindows(22, content, baseDate, SESSION_ID, '/workspace');

      expect(windows).toHaveLength(1);
      expect(windows[0].toolName).toBe('Edit');
    });

    it('should return empty for raw Claude API user messages with tool_result', () => {
      const content = JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              tool_use_id: 'toolu_01XYZ',
              type: 'tool_result',
              content: 'File edited successfully',
            },
          ],
        },
      });

      const windows = parseToolCallWindows(23, content, baseDate, SESSION_ID, '/workspace');

      // tool_result blocks don't have 'name' so they should be skipped
      expect(windows).toHaveLength(0);
    });

    it('should extract tool use id from item', () => {
      const content = JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'mcp_tool_call',
          id: 'toolu_abc123',
          tool_use_id: 'toolu_abc123',
          server: 'test',
          tool: 'Write',
          arguments: { file_path: '/workspace/file.ts' },
        },
      });

      const windows = parseToolCallWindows(13, content, baseDate, SESSION_ID, '/workspace');

      expect(windows).toHaveLength(1);
      expect(windows[0].toolUseId).toBe('toolu_abc123');
      expect(windows[0].toolCallItemId).toBe('toolu_abc123');
    });
  });

  describe('scoreMatch', () => {
    const baseTime = new Date('2026-02-20T12:00:00Z').getTime();

    function makeWindow(overrides: Partial<ToolCallWindow> = {}): ToolCallWindow {
      return {
        messageId: 1,
        messageCreatedAt: baseTime,
        sessionId: 'test-session',
        toolName: 'Edit',
        toolCallItemId: 'tool-1',
        toolUseId: 'toolu_1',
        argsText: '',
        outputText: '',
        ...overrides,
      };
    }

    it('should return null when file timestamp is outside 10s cutoff', () => {
      const window = makeWindow({ argsText: '{"file_path":"/workspace/src/app.ts"}' });
      // 15 seconds after tool call
      const result = scoreMatch('/workspace/src/app.ts', baseTime + 15_000, window);
      expect(result).toBeNull();
    });

    it('should return null when file timestamp is far before tool call', () => {
      const window = makeWindow({ argsText: '{"file_path":"/workspace/src/app.ts"}' });
      // 15 seconds before tool call
      const result = scoreMatch('/workspace/src/app.ts', baseTime - 15_000, window);
      expect(result).toBeNull();
    });

    it('should match by filename in argsText', () => {
      const window = makeWindow({
        argsText: '{"file_path":"/different/workspace/src/app.ts"}',
      });
      // Within time window
      const result = scoreMatch('/workspace/src/app.ts', baseTime + 1_000, window);
      expect(result).not.toBeNull();
      expect(result!.score).toBe(40);
      expect(result!.reasons).toContain('name_in_args');
    });

    it('should match filename in output text', () => {
      const window = makeWindow({
        outputText: 'Successfully wrote to app.ts',
      });
      const result = scoreMatch('/workspace/src/app.ts', baseTime + 1_000, window);
      expect(result).not.toBeNull();
      expect(result!.score).toBe(30);
      expect(result!.reasons).toContain('name_in_output');
    });

    it('should combine name_in_args and name_in_output scores', () => {
      const window = makeWindow({
        argsText: '{"file_path":"/workspace/src/app.ts"}',
        outputText: 'Wrote app.ts successfully',
      });
      const result = scoreMatch('/workspace/src/app.ts', baseTime + 1_000, window);
      expect(result).not.toBeNull();
      expect(result!.score).toBe(70); // 40 + 30
    });

    it('should bypass time cutoff for toolUseId match', () => {
      const window = makeWindow({ toolUseId: 'toolu_exact' });
      // 30 seconds away - way outside the 10s cutoff
      const result = scoreMatch('/workspace/src/app.ts', baseTime + 30_000, window, 'toolu_exact');
      expect(result).not.toBeNull();
      expect(result!.score).toBe(100);
      expect(result!.reasons).toContain('toolUseId');
    });

    it('should return score 0 (below threshold) when within time but no name match', () => {
      const window = makeWindow({
        argsText: '{"file_path":"/workspace/src/other.ts"}',
        outputText: 'no relevant paths here',
      });
      const result = scoreMatch('/workspace/src/app.ts', baseTime + 1_000, window);
      expect(result).not.toBeNull();
      expect(result!.score).toBe(0);
    });

    it('should match at exactly 10s boundary', () => {
      const window = makeWindow({
        argsText: '{"file_path":"/workspace/src/app.ts"}',
      });
      const result = scoreMatch('/workspace/src/app.ts', baseTime + 10_000, window);
      expect(result).not.toBeNull();
      expect(result!.score).toBe(40);
    });

    it('should reject at just over 10s boundary', () => {
      const window = makeWindow({
        argsText: '{"file_path":"/workspace/src/app.ts"}',
      });
      const result = scoreMatch('/workspace/src/app.ts', baseTime + 10_001, window);
      expect(result).toBeNull();
    });

    it('should match file_change by path_in_changes without toolUseId (Codex sessions)', () => {
      // For Codex sessions, toolUseId is not stored in session_files metadata.
      // Matching relies on filename/path heuristics within the time window.
      const fileChangeWindow = makeWindow({
        messageId: 200,
        toolName: 'file_change',
        toolCallItemId: 'item_53',
        toolUseId: 'item_53',
        argsText: '{"changes":[{"path":"/workspace/src/app.ts","kind":"update"}]}',
        args: { changes: [{ path: '/workspace/src/app.ts', kind: 'update' }] },
      });

      // No fileMetadataToolUseId passed — simulates Codex session where we don't store item IDs
      const result = scoreMatch('/workspace/src/app.ts', baseTime + 1_000, fileChangeWindow);
      expect(result).not.toBeNull();
      expect(result!.score).toBe(40); // path_in_changes
      expect(result!.reasons).toContain('path_in_changes');
    });

    it('should not match Codex reused item IDs when toolUseId not in session_files', () => {
      // Codex reuses item IDs across turns. When we don't store toolUseId in
      // session_files metadata, the toolUseId shortcut path is never triggered,
      // so matching falls through to time+filename heuristics.
      const bashWindow = makeWindow({
        messageId: 100,
        toolName: 'Bash',
        toolCallItemId: 'item_53',
        toolUseId: 'item_53',
        argsText: '{"command":"grep -Rns logAgentMessage"}',
      });

      // No fileMetadataToolUseId — toolUseId match path won't fire.
      // File is within time window but filename not in args → no match.
      const result = scoreMatch('/workspace/src/app.ts', baseTime + 1_000, bashWindow);
      expect(result).not.toBeNull();
      expect(result!.score).toBe(0); // No filename match
    });
  });

  // ---------------------------------------------------------------------------
  // Real Codex event fixtures (from session fb958ac8-ce5d-4605-8756-2861ed0c095f)
  // ---------------------------------------------------------------------------

  describe('Codex real event fixtures', () => {
    const baseDate = new Date('2026-02-21T01:55:59Z');
    const SESSION_ID = 'fb958ac8-ce5d-4605-8756-2861ed0c095f';
    const WORKSPACE = '/Users/jordanbentley/git/nimnim_worktrees/noble-owl';

    it('should parse file_change event from Codex apply_diff', () => {
      // Real message 329861 from the Codex session
      const content = JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_9',
          type: 'file_change',
          changes: [
            { path: '/Users/jordanbentley/git/nimnim_worktrees/noble-owl/test/hello.txt', kind: 'update' },
          ],
          status: 'completed',
        },
      });

      const windows = parseToolCallWindows(329861, content, baseDate, SESSION_ID, WORKSPACE);

      expect(windows).toHaveLength(1);
      expect(windows[0].toolName).toBe('file_change');
      expect(windows[0].argsText).toContain('hello.txt');
    });

    it('should parse command_execution bash redirect from Codex', () => {
      // Real message 329867 from the Codex session - bash append via >>
      const content = JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_13',
          type: 'command_execution',
          command: '/bin/zsh -lc "printf \'%s\\n\' \\"Bash edit: appended line on 2026-02-21.\\" >> test/second-file.txt"',
          aggregated_output: '',
          exit_code: 0,
          status: 'completed',
        },
      });

      const windows = parseToolCallWindows(329867, content, baseDate, SESSION_ID, WORKSPACE);

      expect(windows).toHaveLength(1);
      expect(windows[0].toolName).toBe('Bash');
      // After unwrapping /bin/zsh -lc wrapper, the command should be in argsText
      expect(windows[0].argsText).toContain('second-file.txt');
    });

    it('should unwrap /bin/zsh -lc wrapper to extract inner command', () => {
      // Simpler case: zsh wrapping a redirect
      const content = JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'cmd-zsh',
          type: 'command_execution',
          command: "/bin/zsh -lc 'echo hello > /workspace/output.txt'",
          aggregated_output: '',
          exit_code: 0,
          status: 'completed',
        },
      });

      const windows = parseToolCallWindows(1, content, new Date(), 'test', '/workspace');

      expect(windows).toHaveLength(1);
      expect(windows[0].argsText).toContain('output.txt');
    });

    it('should match file_change edit to tool call with consistent timestamps', () => {
      const toolTime = new Date('2026-02-21T01:55:59.477Z').getTime();
      const fileTime = new Date('2026-02-21T01:55:59.481Z').getTime(); // 4ms later (same timezone)

      const window: ToolCallWindow = {
        messageId: 329861,
        messageCreatedAt: toolTime,
        sessionId: SESSION_ID,
        toolName: 'file_change',
        toolCallItemId: 'item_9',
        toolUseId: 'item_9',
        argsText: '{"changes":[{"path":"/Users/jordanbentley/git/nimnim_worktrees/noble-owl/test/hello.txt","kind":"update"}]}',
        outputText: '',
        args: { changes: [{ path: '/Users/jordanbentley/git/nimnim_worktrees/noble-owl/test/hello.txt', kind: 'update' }] },
      };

      const result = scoreMatch(
        '/Users/jordanbentley/git/nimnim_worktrees/noble-owl/test/hello.txt',
        fileTime,
        window
      );

      expect(result).not.toBeNull();
      expect(result!.score).toBe(40); // path_in_changes
      expect(result!.reasons).toContain('path_in_changes');
    });

    it('should NOT match when timestamps have timezone mismatch (Bug 3)', () => {
      // This demonstrates Bug 3: 5-hour offset kills matching
      const toolTimeUtc = new Date('2026-02-21T01:55:59.477Z').getTime();
      const fileTimeLocal = new Date('2026-02-21T06:55:59.481Z').getTime(); // 5h offset

      const window: ToolCallWindow = {
        messageId: 329861,
        messageCreatedAt: toolTimeUtc,
        sessionId: SESSION_ID,
        toolName: 'file_change',
        toolCallItemId: 'item_9',
        toolUseId: null,
        argsText: '{"changes":[{"path":"/Users/jordanbentley/git/nimnim_worktrees/noble-owl/test/hello.txt","kind":"update"}]}',
        outputText: '',
        args: { changes: [{ path: '/Users/jordanbentley/git/nimnim_worktrees/noble-owl/test/hello.txt', kind: 'update' }] },
      };

      const result = scoreMatch(
        '/Users/jordanbentley/git/nimnim_worktrees/noble-owl/test/hello.txt',
        fileTimeLocal,
        window
      );

      // With 5h offset, this falls outside the 10s cutoff
      expect(result).toBeNull();
    });

    it('should parse command_execution without /bin/zsh wrapper', () => {
      // Some Codex commands don't have shell wrappers
      const content = JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'cmd-direct',
          type: 'command_execution',
          command: 'echo "test" > /workspace/direct.txt',
          aggregated_output: '',
          exit_code: 0,
          status: 'completed',
        },
      });

      const windows = parseToolCallWindows(1, content, new Date(), 'test', '/workspace');

      expect(windows).toHaveLength(1);
      expect(windows[0].argsText).toContain('direct.txt');
    });
  });

  describe('extractDiffsFromMessageContent', () => {
    // Access private method for targeted testing
    const extract = (content: string, targetFilePath: string) =>
      (toolCallMatcher as any).extractDiffsFromMessageContent(content, targetFilePath);

    it('should not early-return for file_change items with no arguments but with changes content', () => {
      // file_change items from Codex have no arguments/args/input/parameters,
      // which previously caused an early return at the `if (!args)` guard
      const content = JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'file_change',
          id: 'fc_123',
          changes: [
            { path: '/workspace/src/app.ts', kind: 'update', content: 'const x = 1;\n' },
          ],
        },
      });

      const result = extract(content, '/workspace/src/app.ts');
      expect(result.content).toBe('const x = 1;\n');
      expect(result.diffs).toEqual([]);
    });

    it('should return empty diffs for file_change with changes but no content field', () => {
      // Typical Codex file_change: has changes array but no content on each change
      const content = JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'file_change',
          id: 'fc_456',
          changes: [
            { path: '/workspace/src/app.ts', kind: 'update' },
          ],
        },
      });

      const result = extract(content, '/workspace/src/app.ts');
      expect(result.diffs).toEqual([]);
    });

    it('should return empty diffs for file_change targeting a different file', () => {
      const content = JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'file_change',
          id: 'fc_789',
          changes: [
            { path: '/workspace/src/other.ts', kind: 'update', content: 'other content' },
          ],
        },
      });

      const result = extract(content, '/workspace/src/app.ts');
      expect(result.diffs).toEqual([]);
    });
  });

  describe('workspace-scoped attribution', () => {
    const baseTime = new Date('2026-02-21T01:55:59.477Z').getTime();

    it('scores Bash command text evidence without Bash file-op parsing', () => {
      const window: ToolCallWindow = {
        messageId: 101,
        messageCreatedAt: baseTime,
        sessionId: 'session-bash',
        toolName: 'Bash',
        toolCallItemId: 'item-bash',
        toolUseId: 'item-bash',
        argsText: "{\"command\":\"sed -i 's/foo/bar/' /workspace/src/config.ts\"}",
        outputText: '',
        args: { command: "sed -i 's/foo/bar/' /workspace/src/config.ts" },
      };

      const scored = scoreWorkspaceFileEdit('/workspace/src/config.ts', baseTime + 100, window);
      expect(scored).not.toBeNull();
      expect(scored!.reasons).toContain('bash_command_path_text');
      expect(scored!.score).toBeGreaterThanOrEqual(50);
    });

    it('selects a clear winner across candidate sessions', async () => {
      // Mock database.query for getRawToolCallWindowsMultiSession
      // which queries ai_agent_messages directly
      (database.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [
          {
            session_id: 'session-1',
            id: 1,
            content: JSON.stringify({
              type: 'item.completed',
              item: {
                type: 'file_change',
                id: 'item-fc-1',
                changes: [{ path: '/workspace/src/a.ts', kind: 'update' }],
              },
            }),
            created_at_ms: baseTime,
          },
          {
            session_id: 'session-2',
            id: 2,
            content: JSON.stringify({
              type: 'item.completed',
              item: {
                type: 'command_execution',
                id: 'item-bash-2',
                command: 'echo test >> a.ts',
              },
            }),
            created_at_ms: baseTime + 50,
          },
        ],
      });

      const result = await toolCallMatcher.matchWorkspaceFileEdit({
        workspacePath: '/workspace',
        filePath: '/workspace/src/a.ts',
        fileTimestamp: baseTime + 70,
        candidateSessionIds: ['session-1', 'session-2'],
      });

      expect(result.reason).toBe('winner_selected');
      expect(result.winner?.sessionId).toBe('session-1');
      expect(result.candidates.length).toBe(2);
    });

    it('returns no winner when top candidate scores are tied', async () => {
      (database.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [
          {
            session_id: 'session-a',
            id: 11,
            content: JSON.stringify({
              type: 'item.completed',
              item: {
                type: 'file_change',
                id: 'item-a',
                changes: [{ path: '/workspace/src/shared.ts', kind: 'update' }],
              },
            }),
            created_at_ms: baseTime,
          },
          {
            session_id: 'session-b',
            id: 12,
            content: JSON.stringify({
              type: 'item.completed',
              item: {
                type: 'file_change',
                id: 'item-b',
                changes: [{ path: '/workspace/src/shared.ts', kind: 'update' }],
              },
            }),
            created_at_ms: baseTime,
          },
        ],
      });

      const result = await toolCallMatcher.matchWorkspaceFileEdit({
        workspacePath: '/workspace',
        filePath: '/workspace/src/shared.ts',
        fileTimestamp: baseTime + 50,
        candidateSessionIds: ['session-a', 'session-b'],
      });

      expect(result.winner).toBeNull();
      expect(result.reason).toBe('ambiguous');
      expect(result.candidates.length).toBe(2);
    });

    it('does not let a command that names the file beat another session running an unnamed writer', async () => {
      const assistantToolUse = (sessionId: string, id: number, toolUseId: string, command: string) => ({
        session_id: sessionId,
        id,
        content: JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command } }] },
        }),
        created_at_ms: baseTime,
      });
      (database.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [
          assistantToolUse('reader', 21, 'toolu_reader', 'cat /workspace/src/generated.ts'),
          assistantToolUse('writer', 22, 'toolu_writer', 'node scripts/generate.js'),
        ],
      });

      const result = await toolCallMatcher.matchWorkspaceFileEdit({
        workspacePath: '/workspace',
        filePath: '/workspace/src/generated.ts',
        fileTimestamp: baseTime + 100,
        candidateSessionIds: ['reader', 'writer'],
      });

      expect(result.winner).toBeNull();
      expect(result.reason).toBe('competing_writer');
    });

    // A hook-window session owns its Bash edits through its own tracker. When
    // its tool is the best explanation, no lower-scored session may take it.
    it('gives no winner when the best match belongs to an ineligible hook-window session', async () => {
      (database.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [
          {
            session_id: 'claude-shell', id: 31, created_at_ms: baseTime,
            content: JSON.stringify({ type: 'item.completed', item: { type: 'file_change', id: 'item-c', changes: [{ path: '/workspace/src/c.ts', kind: 'update' }] } }),
          },
          {
            session_id: 'opencode', id: 32, created_at_ms: baseTime + 50,
            content: JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', id: 'item-o', command: 'echo test >> c.ts' } }),
          },
        ],
      });

      const result = await toolCallMatcher.matchWorkspaceFileEdit({
        workspacePath: '/workspace',
        filePath: '/workspace/src/c.ts',
        fileTimestamp: baseTime + 70,
        candidateSessionIds: ['claude-shell', 'opencode'],
        ineligibleSessionIds: ['claude-shell'],
      });

      expect(result.winner).toBeNull();
      expect(result.reason).toBe('shell_window_owner');
    });
  });

  describe('getDiffsForToolCall (Codex synthetic ID lookup)', () => {
    it('queries session_files using both the synthetic and raw lookup forms', async () => {
      const SESSION_ID = 'codex-session';
      const SYNTHETIC = 'nimtc|item_0|1700000000000|7';
      const RAW = 'item_0';

      const queryMock = database.query as ReturnType<typeof vi.fn>;

      // First call: workspace_id lookup inside getDiffsFromToolCallContent.
      queryMock.mockImplementationOnce(async (sql: string) => {
        expect(sql).toContain('workspace_id');
        expect(sql).toContain('FROM ai_sessions');
        return { rows: [{ workspace_id: '/ws' }] };
      });

      // Second call: session_files lookup. The new code uses ANY($2) with both
      // synthetic (primary) and raw (fallback) forms so legacy data still
      // resolves while new data also resolves.
      queryMock.mockImplementationOnce(async (sql: string, params: unknown[]) => {
        expect(sql).toContain('FROM session_files');
        expect(sql).toContain("metadata->>'toolUseId' = ANY($2)");
        const lookupIds = params[1] as string[];
        expect(lookupIds).toContain(SYNTHETIC);
        expect(lookupIds).toContain(RAW);
        return { rows: [] }; // empty so the function returns [] early
      });

      const diffs = await toolCallMatcher.getDiffsForToolCall(
        SESSION_ID,
        SYNTHETIC,
      );
      expect(diffs).toEqual([]);
    });

    it('passes a single id when synthetic and raw collapse to the same value', async () => {
      const SESSION_ID = 'claude-session';
      const RAW = 'toolu_abc'; // not a synthetic ID

      const queryMock = database.query as ReturnType<typeof vi.fn>;

      // workspace_id lookup
      queryMock.mockImplementationOnce(async () => ({ rows: [{ workspace_id: '/ws' }] }));
      // session_files lookup -- both forms equal, expect single-element ANY array
      queryMock.mockImplementationOnce(async (_sql: string, params: unknown[]) => {
        const lookupIds = params[1] as string[];
        expect(lookupIds).toEqual([RAW]);
        return { rows: [] };
      });

      const diffs = await toolCallMatcher.getDiffsForToolCall(SESSION_ID, RAW);
      expect(diffs).toEqual([]);
    });
  });

  describe('raw tool call window paging', () => {
    const queryMock = database.query as ReturnType<typeof vi.fn>;
    const baseTime = 1_700_000_000_000;
    const afterDate = new Date(baseTime - 10_000);
    const beforeDate = new Date(baseTime + 10_000);

    type IdKind = 'number' | 'string' | 'bigint';
    interface RawRow {
      id: number | string | bigint;
      session_id: string;
      content: string;
      metadata: unknown;
      created_at_ms: number;
    }

    function rawRow(sessionId: string, id: number, idKind: IdKind = 'number', toolUse = true): RawRow {
      const content = toolUse
        ? JSON.stringify({
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', id: `toolu_${id}`, name: 'Edit', input: { file_path: `/workspace/src/f${id}.ts` } }],
          },
        })
        : JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'thinking out loud' }] } });
      const typedId = idKind === 'string' ? String(id) : idKind === 'bigint' ? BigInt(id) : id;
      return { id: typedId, session_id: sessionId, content, metadata: {}, created_at_ms: baseTime + id };
    }

    /** What the unpaged scan produced: every row parsed in id order. */
    function unpagedWindows(rows: RawRow[], workspacePath?: string): ToolCallWindow[] {
      return [...rows]
        .sort((a, b) => Number(a.id) - Number(b.id))
        .flatMap(row => parseToolCallWindows(
          Number(row.id), row.content, new Date(row.created_at_ms), row.session_id, workspacePath, row.metadata,
        ));
    }

    /**
     * Stand-in for ai_agent_messages that honors keyset paging the way both
     * backends do: rows above the bound `id > $n` cursor, in id order, capped
     * at the bound LIMIT. A query binding neither gets every row, which is
     * what the unpaged scan received.
     */
    function stubMessagesTable(rows: RawRow[]) {
      const calls: Array<{ params: unknown[]; cursor: number | null; limit: number | null; returned: number }> = [];
      queryMock.mockImplementation(async (sql: string, params: unknown[] = []) => {
        if (!sql.includes('FROM ai_agent_messages')) return { rows: [] };
        const cursorRef = /\bid\s*>\s*\$(\d+)/.exec(sql);
        const limitRef = /\bLIMIT\s+(?:\$(\d+)|(\d+))/i.exec(sql);
        const cursor = cursorRef ? Number(params[Number(cursorRef[1]) - 1]) : null;
        const limit = limitRef
          ? Number(limitRef[1] ? params[Number(limitRef[1]) - 1] : limitRef[2])
          : null;
        const page = [...rows]
          .sort((a, b) => Number(a.id) - Number(b.id))
          .filter(row => cursor === null || Number(row.id) > cursor)
          .slice(0, limit ?? undefined);
        calls.push({ params, cursor, limit, returned: page.length });
        return { rows: page };
      });
      return calls;
    }

    it.each<IdKind>(['number', 'string', 'bigint'])(
      'pages one session by id cursor and returns the unpaged windows in id order (%s ids)',
      async (idKind) => {
        const sessionId = 'paged-session';
        // Id gaps prove the cursor is the last row id, not an offset; row 7 has
        // no tool call, so the cursor must come from rows, not from windows.
        const rows = [3, 7, 8, 20, 21].map(id => rawRow(sessionId, id, idKind, id !== 7));
        const calls = stubMessagesTable(rows);

        const windows = await getRawToolCallWindows(sessionId, '/workspace', { afterDate, beforeDate, pageSize: 2 });

        expect(windows).toEqual(unpagedWindows(rows, '/workspace'));
        expect(windows.map(w => w.messageId)).toEqual([3, 8, 20, 21]);
        // Two full pages, then a short one ends the scan.
        expect(calls.map(c => [c.cursor, c.limit, c.returned])).toEqual([[0, 2, 2], [7, 2, 2], [20, 2, 1]]);
        // Every page keeps the session filter and both time bounds.
        for (const call of calls) {
          expect(call.params.slice(0, 3)).toEqual([sessionId, afterDate.getTime(), beforeDate.getTime()]);
        }
      },
    );

    it('pages the multi-session scan and stops on an empty page after an exactly full one', async () => {
      const sessionIds = ['session-a', 'session-b'];
      const rows = [
        rawRow('session-a', 1),
        rawRow('session-b', 2),
        rawRow('session-a', 5),
        rawRow('session-b', 6),
      ];
      const calls = stubMessagesTable(rows);

      const bySession = await getRawToolCallWindowsMultiSession(sessionIds, { afterDate, beforeDate, pageSize: 2 });

      const expected = unpagedWindows(rows);
      expect(bySession.get('session-a')).toEqual(expected.filter(w => w.sessionId === 'session-a'));
      expect(bySession.get('session-b')).toEqual(expected.filter(w => w.sessionId === 'session-b'));
      expect(calls.map(c => [c.cursor, c.limit, c.returned])).toEqual([[0, 2, 2], [2, 2, 2], [6, 2, 0]]);
      for (const call of calls) {
        expect(call.params.slice(0, 3)).toEqual([sessionIds, afterDate.getTime(), beforeDate.getTime()]);
      }
    });

    it('keeps a worst-case default page under half the SQLite worker response limit', () => {
      // ~550 KB of tool output in one row has been seen in production. The
      // worker sizes a response with this estimator before posting it.
      expect(RAW_TOOL_CALL_PAGE_SIZE).toBeGreaterThan(1);
      const content = 'x'.repeat(550 * 1024);
      const page = Array.from({ length: RAW_TOOL_CALL_PAGE_SIZE }, (_, i) => ({
        id: i + 1, content, metadata: {}, created_at_ms: baseTime,
      }));

      expect(estimateSerializedBytes({ rows: page })).toBeLessThan(DEFAULT_RESPONSE_BYTE_LIMIT / 2);
    });
  });

  describe('matchSession raw-message bounds', () => {
    const queryMock = database.query as ReturnType<typeof vi.fn>;

    /**
     * Dispatch by SQL, and assert AFTER matchSession returns.
     *
     * These used to chain mockImplementationOnce with the expectations inside
     * the mock bodies. matchSession wraps everything in try/catch, so when the
     * query ORDER changed the expect() threw, got swallowed, and the tests
     * still passed on the fallback `return 0` — green while testing nothing.
     * Capture here, assert outside.
     */
    function stubSession(opts: {
      files: Array<Record<string, unknown>>;
      messages?: Array<Record<string, unknown>>;
      existingMatches?: Array<{ session_file_id: string; match_score: number; tool_use_id: string | null }>;
      provider?: string | null;
    }) {
      const captured: {
        messagesSql?: string;
        messagesParams?: unknown[];
        insertParams?: unknown[];
        sawMessagesQuery: boolean;
      } = { sawMessagesQuery: false };

      queryMock.mockImplementation(async (sql: string, params: unknown[]) => {
        if (sql.includes('FROM ai_sessions')) return { rows: [{ workspace_id: '/workspace', provider: opts.provider ?? null }] };
        if (sql.includes('FROM session_files')) return { rows: opts.files };
        if (sql.includes('FROM ai_tool_call_file_edits')) return { rows: opts.existingMatches ?? [] };
        if (sql.includes('FROM ai_agent_messages')) {
          captured.sawMessagesQuery = true;
          captured.messagesSql = sql;
          captured.messagesParams = params;
          return { rows: opts.messages ?? [] };
        }
        if (/^\s*INSERT/i.test(sql)) captured.insertParams = params;
        return { rows: [] };
      });

      return captured;
    }

    const BOUND_LOWER = '(EXTRACT(EPOCH FROM created_at) * 1000) >= $2';
    const BOUND_UPPER = '(EXTRACT(EPOCH FROM created_at) * 1000) <= $3';

    it('bounds sessions without definitive tool IDs to the editable file window', async () => {
      const sessionId = 'bounded-session';
      const earliestTimestamp = 1_700_000_000_000;
      const latestTimestamp = earliestTimestamp + 45_000;

      const captured = stubSession({
        files: [
          { id: 'early-file', file_path: '/workspace/src/early.ts', timestamp_ms: earliestTimestamp, metadata: {} },
          { id: 'late-file', file_path: '/workspace/src/late.ts', timestamp_ms: latestTimestamp, metadata: {} },
        ],
      });

      await expect(toolCallMatcher.matchSession(sessionId)).resolves.toBe(0);

      expect(captured.sawMessagesQuery).toBe(true);
      expect(captured.messagesSql).toContain(BOUND_LOWER);
      expect(captured.messagesSql).toContain(BOUND_UPPER);
      // Trailing pair is the first page's keyset cursor and LIMIT.
      expect(captured.messagesParams).toEqual([
        sessionId,
        earliestTimestamp - 10_000,
        latestTimestamp + 10_000,
        0,
        RAW_TOOL_CALL_PAGE_SIZE,
      ]);
    });

    // PGLite hands session_files.metadata back as an object, SQLite as JSON text.
    it.each([
      ['object (PGLite)', { toolUseId: 'tool-definitive' }],
      ['JSON string (SQLite)', JSON.stringify({ toolUseId: 'tool-definitive' })],
    ])('preserves out-of-window exact toolUseId matches with an unbounded lookup, metadata as %s', async (_shape, metadata) => {
      const sessionId = 'definitive-id-session';
      const fileTimestamp = 1_700_000_000_000;
      const toolTimestamp = fileTimestamp - 60_000;

      const captured = stubSession({
        provider: 'claude-code',
        files: [{
          id: 'file-1',
          file_path: '/workspace/src/kept.ts',
          timestamp_ms: fileTimestamp,
          metadata,
        }],
        messages: [{
          id: 42,
          created_at_ms: toolTimestamp,
          metadata: {},
          content: JSON.stringify({
            type: 'assistant',
            message: {
              content: [{
                type: 'tool_use',
                id: 'tool-definitive',
                name: 'Edit',
                input: { file_path: '/workspace/src/kept.ts' },
              }],
            },
          }),
        }],
      });

      await expect(toolCallMatcher.matchSession(sessionId)).resolves.toBe(1);

      // The tool call is 60s before the edit — far outside TIME_CUTOFF_MS — so
      // it is only reachable because the lookup stayed unbounded.
      expect(captured.messagesSql).not.toContain(BOUND_LOWER);
      expect(captured.messagesSql).not.toContain(BOUND_UPPER);
      expect(captured.messagesParams).toEqual([sessionId, 0, RAW_TOOL_CALL_PAGE_SIZE]);
      expect(captured.insertParams).toEqual(expect.arrayContaining([
        sessionId,
        'file-1',
        42,
        'tool-definitive',
        100,
      ]));
    });

    it('B1: bounds a Codex edit-group id to the edit window and still scores the window that carries it 100', async () => {
      const sessionId = 'minted-id-session';
      const fileTimestamp = 1_700_000_000_000;
      const editGroupId = 'nimtc|item_3|1700000000000|9';

      const captured = stubSession({
        files: [{ id: 'file-codex', file_path: '/workspace/src/a.ts', timestamp_ms: fileTimestamp, metadata: { toolUseId: editGroupId } }],
        messages: [{
          id: 12,
          created_at_ms: fileTimestamp - 1_000,
          metadata: { editGroupId },
          content: JSON.stringify({
            type: 'item.completed',
            item: { type: 'file_change', id: 'item_3', changes: [{ path: '/workspace/src/a.ts', kind: 'update' }] },
          }),
        }],
      });

      await expect(toolCallMatcher.matchSession(sessionId)).resolves.toBe(1);

      // Trailing pair is the first page's keyset cursor and LIMIT.
      expect(captured.messagesParams).toEqual([sessionId, fileTimestamp - 10_000, fileTimestamp + 10_000, 0, RAW_TOOL_CALL_PAGE_SIZE]);
      expect(captured.insertParams).toEqual(expect.arrayContaining([sessionId, 'file-codex', 12, editGroupId, 100]));
    });

    it.each([
      ['openai-codex', 'bounded'],
      ['openai-codex-acp', 'bounded'],
      ['cursor-agent', 'bounded'],
      ['antigravity-gemini-agent', 'bounded'],
      ['an-unknown-future-agent', 'bounded'],
      // The session lookup gave no provider (its ai_sessions row is gone).
      [null, 'bounded'],
      ['claude-code', 'unbounded'],
      ['claude-code-cli', 'unbounded'],
    ])('B3/B4: a %s session\'s own tool-call id leaves the lookup %s', async (provider, expected) => {
      // Only Claude Code's stored rows were traced to carry the ids its edits
      // record; every other provider's ids may never resolve. Two commands
      // changed package.json; outside Claude Code only the newest row counts, so
      // the earlier one cannot widen the window.
      const sessionId = `provider-id-${provider}`;
      const fileTimestamp = 1_700_000_000_000;

      const captured = stubSession({
        provider,
        files: [
          { id: 'file-shell-1', file_path: '/workspace/package.json', timestamp_ms: fileTimestamp - 60_000, metadata: { toolUseId: 'call_3' } },
          { id: 'file-shell-2', file_path: '/workspace/package.json', timestamp_ms: fileTimestamp, metadata: { toolUseId: 'call_7' } },
        ],
      });

      await expect(toolCallMatcher.matchSession(sessionId)).resolves.toBe(0);

      // Trailing pair is the first page's keyset cursor and LIMIT.
      expect(captured.messagesParams).toEqual(expected === 'bounded'
        ? [sessionId, fileTimestamp - 10_000, fileTimestamp + 10_000, 0, RAW_TOOL_CALL_PAGE_SIZE]
        : [sessionId, 0, RAW_TOOL_CALL_PAGE_SIZE]);
    });

    it('falls back to an unbounded lookup when a stored file timestamp is invalid', async () => {
      const sessionId = 'invalid-timestamp-session';

      const captured = stubSession({
        files: [{
          id: 'file-invalid',
          file_path: '/workspace/src/invalid.ts',
          timestamp_ms: 'not-a-number',
          metadata: {},
        }],
      });

      await expect(toolCallMatcher.matchSession(sessionId)).resolves.toBe(0);

      expect(captured.sawMessagesQuery).toBe(true);
      expect(captured.messagesSql).not.toContain(BOUND_LOWER);
      expect(captured.messagesSql).not.toContain(BOUND_UPPER);
      expect(captured.messagesParams).toEqual([sessionId, 0, RAW_TOOL_CALL_PAGE_SIZE]);
    });
  });

  describe('matchSession incremental work (NIM-3085)', () => {
    const queryMock = database.query as ReturnType<typeof vi.fn>;

    /**
     * Dispatch by SQL rather than call order — this suite is about WHICH
     * queries run, so pinning an order would obscure the thing under test.
     */
    function stubQueries(opts: {
      files: Array<{ id: string; file_path: string; timestamp_ms: number; metadata: any }>;
      existingMatches: Array<{ session_file_id: string; match_score: number; tool_use_id: string | null }>;
    }) {
      const seen: string[] = [];
      queryMock.mockImplementation(async (sql: string) => {
        seen.push(sql);
        if (sql.includes('FROM ai_sessions')) return { rows: [{ workspace_id: '/workspace' }] };
        if (sql.includes('FROM session_files')) return { rows: opts.files };
        if (sql.includes('FROM ai_tool_call_file_edits')) return { rows: opts.existingMatches };
        if (sql.includes('FROM ai_agent_messages')) return { rows: [] };
        return { rows: [] };
      });
      return { seen, scannedMessages: () => seen.some(s => s.includes('FROM ai_agent_messages')) };
    }

    it('skips the transcript scan when every file already has a definitive match', async () => {
      // score 100 == exact toolUseId match, the ceiling scoreMatch can return.
      // Re-scoring these can never change the outcome, so the expensive
      // unbounded ai_agent_messages scan is pure waste.
      const probe = stubQueries({
        files: [
          { id: 'f1', file_path: '/workspace/a.ts', timestamp_ms: 1_700_000_000_000, metadata: { toolUseId: 't1' } },
          { id: 'f2', file_path: '/workspace/b.ts', timestamp_ms: 1_700_000_001_000, metadata: { toolUseId: 't2' } },
        ],
        existingMatches: [
          { session_file_id: 'f1', match_score: 100, tool_use_id: 't1' },
          { session_file_id: 'f2', match_score: 100, tool_use_id: 't2' },
        ],
      });

      await expect(toolCallMatcher.matchSession('settled-session')).resolves.toBe(0);

      expect(probe.scannedMessages()).toBe(false);
    });

    it('still scans when at least one file is unmatched', async () => {
      const probe = stubQueries({
        files: [
          { id: 'f1', file_path: '/workspace/a.ts', timestamp_ms: 1_700_000_000_000, metadata: { toolUseId: 't1' } },
          { id: 'f2', file_path: '/workspace/b.ts', timestamp_ms: 1_700_000_001_000, metadata: { toolUseId: 't2' } },
        ],
        existingMatches: [{ session_file_id: 'f1', match_score: 100, tool_use_id: 't1' }],
      });

      await toolCallMatcher.matchSession('partial-session');

      expect(probe.scannedMessages()).toBe(true);
    });

    it('still scans a file whose existing match is below the ceiling (replaceable)', async () => {
      // A 70-score heuristic match CAN be beaten by a later exact-id match,
      // so these files must stay in the candidate set.
      const probe = stubQueries({
        files: [
          { id: 'f1', file_path: '/workspace/a.ts', timestamp_ms: 1_700_000_000_000, metadata: { toolUseId: 't1' } },
        ],
        existingMatches: [{ session_file_id: 'f1', match_score: 70, tool_use_id: null }],
      });

      await toolCallMatcher.matchSession('improvable-session');

      expect(probe.scannedMessages()).toBe(true);
    });
  });

  describe('matchSession under load (#1649)', () => {
    const queryMock = database.query as ReturnType<typeof vi.fn>;
    const T0 = 1_700_000_000_000;
    const HOUR = 3_600_000;
    const at = (hour: number, offsetMs = 0) => T0 + hour * HOUR + offsetMs;

    interface FileRow { id: string; file_path: string; timestamp_ms: number | string; metadata: Record<string, unknown> }
    interface ExistingMatch { session_file_id: string; match_score: number; tool_use_id: string | null }
    interface MessageRow { id: number; session_id: string; content: string; metadata: unknown; created_at_ms: number }
    /** `provider` is ai_sessions.provider, which decides whether a toolUseId can be definitive. */
    interface SessionTables { provider: string | null; files: FileRow[]; existing: ExistingMatch[]; rows: MessageRow[] }

    /**
     * In-memory stand-in for the tables matchSession reads and writes, per
     * session. It honors the scan's keyset paging and time bounds and the
     * re-read by id; inserted matches become existing ones and replaced ones
     * go, as in the real table. A session's scan waits on its gate, if set; a
     * session in `failScan` has its next scan refused; an id in `vanished` is
     * missing when re-read.
     */
    function stubMatchTables(tables: Record<string, SessionTables>) {
      const log = {
        scans: [] as string[],
        rereads: [] as number[],
        inserts: [] as unknown[][],
        deletedMatches: [] as unknown[][],
        deletedFiles: [] as unknown[][],
      };
      const gates = new Map<string, Promise<void>>();
      const failScan = new Set<string>();
      const vanished = new Set<number>();

      queryMock.mockImplementation(async (sql: string, params: unknown[] = []) => {
        if (/^\s*DELETE FROM session_files/.test(sql)) {
          log.deletedFiles.push(params);
          return { rows: [] };
        }
        const sessionId = params[0] as string;
        const table = tables[sessionId];
        if (sql.includes('FROM ai_sessions')) return { rows: [{ workspace_id: '/workspace', provider: table.provider }] };
        if (sql.includes('FROM session_files')) return { rows: table.files };
        if (/^\s*DELETE FROM ai_tool_call_file_edits/.test(sql)) {
          log.deletedMatches.push(params);
          const replaced = params[1] as string[];
          table.existing = table.existing.filter(m => !replaced.includes(m.session_file_id));
          return { rows: [] };
        }
        if (/^\s*INSERT INTO ai_tool_call_file_edits/.test(sql)) {
          log.inserts.push(params);
          for (let i = 0; i < params.length; i += 8) {
            table.existing.push({
              session_file_id: params[i + 1] as string,
              match_score: params[i + 5] as number,
              tool_use_id: params[i + 4] as string | null,
            });
          }
          return { rows: [] };
        }
        if (sql.includes('FROM ai_tool_call_file_edits')) return { rows: [...table.existing] };
        if (sql.includes('FROM ai_agent_messages')) {
          const param = (pattern: RegExp) => {
            const ref = pattern.exec(sql);
            return ref ? params[Number(ref[1]) - 1] : undefined;
          };
          const byId = param(/\bid\s*=\s*\$(\d+)/);
          if (byId !== undefined) {
            log.rereads.push(Number(byId));
            if (vanished.has(Number(byId))) return { rows: [] };
            return { rows: table.rows.filter(row => row.id === Number(byId)) };
          }
          const cursor = Number(param(/\bid\s*>\s*\$(\d+)/));
          const limit = Number(param(/\bLIMIT\s+\$(\d+)/i));
          const after = param(/>=\s*\$(\d+)/) as number | undefined;
          const before = param(/<=\s*\$(\d+)/) as number | undefined;
          if (cursor === 0) {
            log.scans.push(sessionId);
            await gates.get(sessionId);
            if (failScan.delete(sessionId)) throw new Error('database worker exited');
          }
          const page = [...table.rows]
            .sort((a, b) => a.id - b.id)
            .filter(row => row.id > cursor
              && (after === undefined || row.created_at_ms >= after)
              && (before === undefined || row.created_at_ms <= before))
            .slice(0, limit);
          return { rows: page };
        }
        throw new Error(`unexpected query: ${sql}`);
      });

      return { log, gates, failScan, vanished };
    }

    function deferred() {
      let resolve!: () => void;
      const promise = new Promise<void>(r => { resolve = r; });
      return { promise, resolve };
    }

    /** Let every pending mock query and continuation run. */
    const settle = () => new Promise(resolve => setTimeout(resolve, 0));

    /**
     * One file whose recorded toolUseId no window carries, matched at 40 by a
     * nearby Read: it never reaches the definitive score, so every pass scans,
     * which is the shape that repeated after every tool call in #1649. A
     * Claude Code session, whose toolUseIds are definitive.
     */
    function busySession(sessionId: string): SessionTables {
      return {
        provider: 'claude-code',
        files: [{ id: `${sessionId}-file`, file_path: '/workspace/src/app.ts', timestamp_ms: T0, metadata: { toolUseId: 'toolu_unrecorded' } }],
        existing: [],
        rows: [{
          id: 1,
          session_id: sessionId,
          content: JSON.stringify({
            type: 'assistant',
            message: { content: [{ type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: '/workspace/src/app.ts' } }] },
          }),
          metadata: {},
          created_at_ms: T0 - 1_000,
        }],
      };
    }

    describe('one pass per session', () => {
      it('runs one scan for a burst of calls on one session, plus one trailing pass they all share', async () => {
        const { log, gates } = stubMatchTables({ busy: busySession('busy') });
        const gate = deferred();
        gates.set('busy', gate.promise);

        const calls = Array.from({ length: 5 }, () => toolCallMatcher.matchSession('busy'));
        await settle();
        gate.resolve();
        const counts = await Promise.all(calls);

        expect(log.scans).toEqual(['busy', 'busy']);
        // The first caller gets the pass it started. The other four share the
        // trailing pass, which started after their calls and found the match
        // already stored.
        expect(counts).toEqual([1, 0, 0, 0, 0]);
        expect(log.inserts).toHaveLength(1);
      });

      it('gives a call made during a failed pass a fresh pass, and takes calls normally after it', async () => {
        const { log, failScan } = stubMatchTables({ flaky: busySession('flaky') });
        failScan.add('flaky');

        const failed = toolCallMatcher.matchSession('flaky');
        const during = toolCallMatcher.matchSession('flaky');

        await expect(failed).resolves.toBe(0);
        await expect(during).resolves.toBe(1);
        await expect(toolCallMatcher.matchSession('flaky')).resolves.toBe(0);
        expect(log.scans).toEqual(['flaky', 'flaky', 'flaky']);
        expect(log.inserts).toHaveLength(1);
      });

      it('runs the trailing pass and later calls when a pass rejects', async () => {
        const { log } = stubMatchTables({ shaky: busySession('shaky') });
        const internals = toolCallMatcher as unknown as { runMatchSessionPass(sessionId: string): Promise<number> };
        const spy = vi.spyOn(internals, 'runMatchSessionPass').mockRejectedValueOnce(new Error('pass crashed'));
        try {
          const crashed = toolCallMatcher.matchSession('shaky');
          const queued = toolCallMatcher.matchSession('shaky');

          await expect(crashed).rejects.toThrow('pass crashed');
          await expect(queued).resolves.toBe(1);
          await expect(toolCallMatcher.matchSession('shaky')).resolves.toBe(0);
          // The rejected pass never reached the database; the other two scanned.
          expect(log.scans).toEqual(['shaky', 'shaky']);
        } finally {
          spy.mockRestore();
        }
      });

      it('does not hold one session behind another session\'s pass', async () => {
        const { log, gates } = stubMatchTables({ slow: busySession('slow'), quick: busySession('quick') });
        const gate = deferred();
        gates.set('slow', gate.promise);

        let slowSettled = false;
        const slow = toolCallMatcher.matchSession('slow').finally(() => { slowSettled = true; });
        await settle();

        await expect(toolCallMatcher.matchSession('quick')).resolves.toBe(1);
        expect(slowSettled).toBe(false);
        expect(log.scans).toEqual(['slow', 'quick']);

        gate.resolve();
        await expect(slow).resolves.toBe(1);
      });
    });

    describe('bounded retention', () => {
      const SESSION = 'long-session';

      /**
       * Hours of earlier tool calls, then one case per kind of file needing
       * work, an hour apart so their windows never overlap. Rows are in time
       * order, as the transcript writes them.
       */
      function longSessionTables(sessionId: string) {
        const rows: MessageRow[] = [];
        const add = (createdAt: number, content: unknown) => {
          const id = rows.length + 1;
          rows.push({ id, session_id: sessionId, content: JSON.stringify(content), metadata: {}, created_at_ms: createdAt });
          return id;
        };
        const toolUse = (createdAt: number, toolUseId: string, name: string, input: Record<string, unknown>) =>
          add(createdAt, { type: 'assistant', message: { content: [{ type: 'tool_use', id: toolUseId, name, input }] } });
        const sdkEvent = (createdAt: number, type: 'item.started' | 'item.completed', item: Record<string, unknown>) =>
          add(createdAt, { type, item });

        // Earlier work: Claude tool calls, started/completed pairs with
        // output, commands with no item id, and plain text.
        for (let i = 0; i < 300; i++) {
          const t = T0 + i * 30_000;
          toolUse(t, `toolu_fill_${i}`, 'Edit', { file_path: `/workspace/src/fill-${i}.ts`, old_string: 'a', new_string: 'b' });
          if (i % 3 === 0) {
            const command = `/bin/zsh -lc 'cat src/fill-${i}.ts'`;
            sdkEvent(t + 1_000, 'item.started', { type: 'command_execution', id: `cmd_fill_${i}`, command });
            sdkEvent(t + 2_000, 'item.completed', { type: 'command_execution', id: `cmd_fill_${i}`, command, aggregated_output: 'x'.repeat(2_000) });
          }
          if (i % 10 === 0) {
            sdkEvent(t + 3_000, 'item.completed', { type: 'command_execution', command: `ls src/fill-${i}`, aggregated_output: 'fill' });
          }
          if (i % 7 === 0) add(t + 4_000, { type: 'assistant', message: { content: [{ type: 'text', text: 'working on it' }] } });
          // Codex reuses item ids across turns; this one comes back at hour 14.
          if (i === 50) sdkEvent(t + 5_000, 'item.completed', { type: 'file_change', id: 'item_reused', changes: [{ path: '/workspace/src/reused.ts', kind: 'update' }] });
        }

        const ids: Record<string, number> = {};
        // never.ts: its file row names a toolUseId no window has, so it stays
        // "needing work" forever; another call named it just before.
        ids.never = toolUse(at(4, -2_000), 'toolu_wrongid', 'Edit', { file_path: '/workspace/src/never.ts' });
        // timed.ts: matched by time and name only. A Claude call and a later
        // command with no item id both score 40; dedup puts item-less windows
        // first, so the command wins although it was read second.
        ids.timedClaude = toolUse(at(5, -3_000), 'toolu_timed', 'Edit', { file_path: '/workspace/src/timed.ts' });
        ids.timedNoItem = sdkEvent(at(5, -1_000), 'item.completed', { type: 'command_execution', command: 'sed -i s/a/b/ src/timed.ts', aggregated_output: 'done' });
        // edge.ts: a five-minute tool whose completed event has no args. Its
        // started row is outside the bounded scan, so there it stays unfilled.
        ids.edgeStarted = sdkEvent(at(5, -300_000), 'item.started', { type: 'tool_call', id: 'call_edge', name: 'Write', arguments: { file_path: '/workspace/src/edge.ts' } });
        ids.edgeCompleted = sdkEvent(at(5, 4_000), 'item.completed', { type: 'tool_call', id: 'call_edge', name: 'Write', result: 'ok' });
        // better.ts: stored at 40 from a nearby Read; its own call ran a minute
        // before the edit was recorded, so only its toolUseId reaches it, at 100.
        ids.better = toolUse(at(6, -60_000), 'toolu_better', 'Write', { file_path: '/workspace/src/better.ts', content: 'x' });
        ids.betterNear = toolUse(at(6, -1_000), 'toolu_better_near', 'Read', { file_path: '/workspace/src/better.ts' });
        // long.ts: a five-minute tool whose completed event has no args; they
        // come from its started row, far outside the edit's window.
        ids.longStarted = sdkEvent(at(7, -300_000), 'item.started', { type: 'tool_call', id: 'call_long', name: 'Write', arguments: { file_path: '/workspace/src/long.ts' } });
        ids.longCompleted = sdkEvent(at(7, -1_000), 'item.completed', { type: 'tool_call', id: 'call_long', name: 'Write', result: 'ok' });
        // short.ts: the same shape with both rows inside the edit's window;
        // the completed row lands after the edit was recorded.
        ids.shortStarted = sdkEvent(at(8, -2_000), 'item.started', { type: 'tool_call', id: 'call_short', name: 'Write', arguments: { file_path: '/workspace/src/short.ts' } });
        ids.shortCompleted = sdkEvent(at(8, 3_000), 'item.completed', { type: 'tool_call', id: 'call_short', name: 'Write', result: 'wrote short.ts' });
        // stale.ts: edited just after a tool started that completed two minutes
        // later. Dedup keeps the completed window, which is out of range.
        ids.staleStarted = sdkEvent(at(9, -500), 'item.started', { type: 'tool_call', id: 'call_stale', name: 'Write', arguments: { file_path: '/workspace/src/stale.ts' } });
        sdkEvent(at(9, 120_000), 'item.completed', { type: 'tool_call', id: 'call_stale', name: 'Write', arguments: { file_path: '/workspace/src/stale.ts' }, result: 'ok' });
        // tie.ts: A and B score the same. A appeared first but B completed
        // first; dedup keeps first-appearance order, so A wins.
        sdkEvent(at(10, -4_000), 'item.started', { type: 'tool_call', id: 'call_tie_a', name: 'Edit', arguments: { file_path: '/workspace/src/tie.ts' } });
        sdkEvent(at(10, -3_000), 'item.started', { type: 'tool_call', id: 'call_tie_b', name: 'Edit', arguments: { file_path: '/workspace/src/tie.ts' } });
        ids.tieBCompleted = sdkEvent(at(10, -2_500), 'item.completed', { type: 'tool_call', id: 'call_tie_b', name: 'Edit', arguments: { file_path: '/workspace/src/tie.ts' }, result: 'ok' });
        ids.tieACompleted = sdkEvent(at(10, -2_000), 'item.completed', { type: 'tool_call', id: 'call_tie_a', name: 'Edit', arguments: { file_path: '/workspace/src/tie.ts' }, result: 'ok' });
        // settled.ts: already matched at 100, so not needing work.
        toolUse(at(11, -1_000), 'toolu_settled', 'Write', { file_path: '/workspace/src/settled.ts', content: 'x' });
        // nan.ts: matched only when a file timestamp cannot be read (scenario).
        ids.nanNamed = toolUse(at(13), 'toolu_nan_named', 'Edit', { file_path: '/workspace/src/nan.ts' });
        // reused.ts: written under a reused item id. Dedup keeps the id's first
        // completed window, hours earlier, so an unbounded scan finds no match;
        // a bounded scan never sees the early one and matches this one.
        ids.reusedLate = sdkEvent(at(14, -1_000), 'item.completed', { type: 'file_change', id: 'item_reused', changes: [{ path: '/workspace/src/reused.ts', kind: 'update' }] });

        const file = (id: string, name: string, timestamp: number | string, metadata: Record<string, unknown> = {}): FileRow =>
          ({ id, file_path: `/workspace/src/${name}`, timestamp_ms: timestamp, metadata });
        const tables: SessionTables = {
          // Its file rows carry Claude Code tool_use ids, so they are definitive.
          provider: 'claude-code',
          files: [
            file('f-never', 'never.ts', at(4), { toolUseId: 'toolu_never' }),
            file('f-timed', 'timed.ts', at(5)),
            file('f-edge', 'edge.ts', at(5, 5_000)),
            file('f-better', 'better.ts', at(6), { toolUseId: 'toolu_better' }),
            file('f-long', 'long.ts', at(7)),
            file('f-short', 'short.ts', at(8)),
            file('f-stale', 'stale.ts', at(9)),
            file('f-tie', 'tie.ts', at(10)),
            file('f-settled', 'settled.ts', at(11), { toolUseId: 'toolu_settled' }),
            file('f-orphan', 'generated.ts', at(12), { bashSideEffect: true }),
            file('f-reused', 'reused.ts', at(14)),
          ],
          existing: [
            { session_file_id: 'f-better', match_score: 40, tool_use_id: 'toolu_better_near' },
            { session_file_id: 'f-settled', match_score: 100, tool_use_id: 'toolu_settled' },
          ],
          rows,
        };
        return { tables, ids };
      }

      /** Copy of deduplicateWindows as of 2ada5922e (its allMessages branch never changed the result). */
      function dedupLikeBefore(windows: ToolCallWindow[]): ToolCallWindow[] {
        const byItemId = new Map<string, ToolCallWindow[]>();
        const noItemId: ToolCallWindow[] = [];
        for (const w of windows) {
          if (w.toolCallItemId) {
            const group = byItemId.get(w.toolCallItemId);
            if (group) group.push(w);
            else byItemId.set(w.toolCallItemId, [w]);
          } else {
            noItemId.push(w);
          }
        }
        const result = [...noItemId];
        for (const group of byItemId.values()) {
          const completed = group.find(w => w.isCompleted);
          if (completed) {
            const started = group.find(w => !w.isCompleted);
            if (started && !completed.argsText && started.argsText) {
              completed.argsText = started.argsText;
              completed.args = started.args;
            }
            result.push(completed);
          } else {
            result.push(group[0]);
          }
        }
        return result;
      }

      /**
       * Copy of definitiveToolUseId as of 371386f62: only a Claude Code
       * session's own tool-call ids are definitive, never ids Nimbalyst minted.
       */
      function definitiveIdLikeBefore(f: FileRow, provider: string | null): string | null {
        const toolUseId = f.metadata.toolUseId;
        if (provider !== 'claude-code' && provider !== 'claude-code-cli') return null;
        if (typeof toolUseId !== 'string' || toolUseId.length === 0) return null;
        return ['nimtc|', 'watcher-', 'codex-bash-', 'codex-acp-write-'].some(p => toolUseId.startsWith(p)) ? null : toolUseId;
      }

      /**
       * The decision path of matchSession as of 2ada5922e, with 371386f62's
       * definitive-id rule: parse every row the scan returns, deduplicate the
       * whole list, score every window against every file needing work.
       * Returns the writes it makes.
       */
      function writesOfScanEverything(sessionId: string, tables: SessionTables) {
        const byKey = new Map<string, FileRow>();
        for (const f of tables.files) {
          const toolUseId = definitiveIdLikeBefore(f, tables.provider);
          const key = toolUseId ? `${f.file_path}::${toolUseId}` : `no-tool::${f.file_path}`;
          const kept = byKey.get(key);
          if (!kept || Number(f.timestamp_ms) > Number(kept.timestamp_ms)) byKey.set(key, f);
        }
        const sessionFiles = [...byKey.values()];
        const previousBest = new Map<string, number>();
        for (const m of tables.existing) {
          previousBest.set(m.session_file_id, Math.max(previousBest.get(m.session_file_id) ?? 0, m.match_score));
        }
        const needing = sessionFiles.filter(f => (previousBest.get(f.id) ?? -1) < 100);
        const nothing = { inserts: [] as unknown[][], deletedMatches: [] as unknown[][], deletedFiles: [] as unknown[][] };

        let rows = [...tables.rows].sort((a, b) => a.id - b.id);
        const definitive = needing.some(f => definitiveIdLikeBefore(f, tables.provider) !== null);
        const stamps = needing.map(f => Number(f.timestamp_ms));
        if (!definitive && stamps.every(Number.isFinite)) {
          const after = new Date(Math.min(...stamps) - 10_000).getTime();
          const before = new Date(Math.max(...stamps) + 10_000).getTime();
          rows = rows.filter(row => row.created_at_ms >= after && row.created_at_ms <= before);
        }
        const windows = rows.flatMap(row =>
          parseToolCallWindows(row.id, row.content, new Date(row.created_at_ms), sessionId, '/workspace', row.metadata));
        const deduped = dedupLikeBefore(windows);
        if (needing.length === 0 || windows.length === 0) return { ...nothing, windows, deduped, needing };

        const inserts: unknown[] = [];
        const replaced: string[] = [];
        const matched: string[] = [];
        for (const f of needing) {
          const ts = Number(f.timestamp_ms);
          const best = deduped
            .map(w => scoreMatch(f.file_path, ts, w, f.metadata.toolUseId as string | undefined))
            .filter((c): c is NonNullable<typeof c> => c !== null && c.score >= 30)
            .sort((a, b) => b.score - a.score)[0];
          if (!best) continue;
          const previous = previousBest.get(f.id);
          if (previous != null) {
            if (best.score <= previous) continue;
            replaced.push(f.id);
          }
          matched.push(f.id);
          inserts.push(
            sessionId, f.id, best.window.messageId, best.window.toolCallItemId, best.window.toolUseId, best.score,
            `${best.reasons.join(',')}|score=${best.score}|tool=${best.window.toolName}`, ts ? new Date(ts) : null,
          );
        }
        const settled = new Set([...matched, ...previousBest.keys()]);
        const orphans = sessionFiles.filter(f => f.metadata.bashSideEffect === true && !settled.has(f.id)).map(f => f.id);
        return {
          inserts: inserts.length > 0 ? [inserts] : [],
          deletedMatches: replaced.length > 0 ? [[sessionId, replaced]] : [],
          deletedFiles: orphans.length > 0 ? [[orphans]] : [],
          windows,
          deduped,
          needing,
        };
      }

      /** Matched (file id, message id) pairs from one INSERT's params. */
      const insertedPairs = (params: unknown[]) =>
        Array.from({ length: params.length / 8 }, (_, i) => [params[i * 8 + 1], params[i * 8 + 2], params[i * 8 + 5]]);

      const scenarios: Array<[string, (tables: SessionTables) => SessionTables]> = [
        ['files with toolUseIds, so the scan is unbounded', tables => tables],
        ['a file whose timestamp cannot be read, so every window is in range', tables => ({
          ...tables,
          files: [...tables.files, { id: 'f-nan', file_path: '/workspace/src/nan.ts', timestamp_ms: 'not-a-number', metadata: { toolUseId: 'toolu_nan_missing' } }],
        })],
        ['no toolUseIds needing work, so the scan is time-bounded', tables => ({
          ...tables,
          files: tables.files.filter(f => f.id !== 'f-never' && f.id !== 'f-better'),
          existing: tables.existing.filter(m => m.session_file_id !== 'f-better'),
        })],
        ['toolUseIds of a provider without definitive ids, so the scan is time-bounded', tables => ({
          ...tables,
          provider: 'openai-codex',
        })],
      ];

      it.each(scenarios)('writes the same matches as the scan-everything path: %s', async (_name, shape) => {
        const tables = shape(longSessionTables(SESSION).tables);
        const expected = writesOfScanEverything(SESSION, tables);
        const { log } = stubMatchTables({ [SESSION]: tables });

        const count = await toolCallMatcher.matchSession(SESSION);

        expect(log.inserts).toEqual(expected.inserts);
        expect(log.deletedMatches).toEqual(expected.deletedMatches);
        expect(log.deletedFiles).toEqual(expected.deletedFiles);
        expect(count).toBe(expected.inserts.length > 0 ? expected.inserts[0].length / 8 : 0);
      });

      it('the fixture exercises each case: replacement, backfill, dedup order, out-of-range and reused calls', () => {
        const { tables, ids } = longSessionTables(SESSION);
        const unbounded = writesOfScanEverything(SESSION, tables);
        expect(insertedPairs(unbounded.inserts[0])).toEqual([
          ['f-never', ids.never, 40],
          ['f-timed', ids.timedNoItem, 40],
          ['f-edge', ids.edgeCompleted, 40],
          ['f-better', ids.better, 100],
          ['f-long', ids.longCompleted, 40],
          ['f-short', ids.shortCompleted, 70],
          ['f-tie', ids.tieACompleted, 40],
        ]);
        expect(unbounded.deletedMatches).toEqual([[SESSION, ['f-better']]]);
        expect(unbounded.deletedFiles).toEqual([[['f-orphan']]]);
        // Bounded, edge.ts's started row is out of range, so its completed
        // window keeps no args and no longer matches, and reused.ts's early
        // window is out of range, so the late one matches.
        const bounded = writesOfScanEverything(SESSION, scenarios[2][1](tables));
        expect(insertedPairs(bounded.inserts[0])).toEqual([
          ['f-timed', ids.timedNoItem, 40],
          ['f-long', ids.longCompleted, 40],
          ['f-short', ids.shortCompleted, 70],
          ['f-tie', ids.tieACompleted, 40],
          ['f-reused', ids.reusedLate, 40],
        ]);
        // Outside Claude Code the same toolUseIds are not definitive, so the scan
        // is bounded to the edits: better.ts still reaches 100 through its id,
        // and reused.ts's early window is out of range, so the late one matches.
        const otherProvider = writesOfScanEverything(SESSION, scenarios[3][1](tables));
        expect(insertedPairs(otherProvider.inserts[0])).toEqual([
          ...insertedPairs(unbounded.inserts[0]),
          ['f-reused', ids.reusedLate, 40],
        ]);
      });

      it('keeps payload only for windows that can score for a file needing work', async () => {
        const { tables, ids } = longSessionTables(SESSION);
        const expected = writesOfScanEverything(SESSION, tables);
        const { log } = stubMatchTables({ [SESSION]: tables });

        const scan = await getMatchableToolCallWindows(SESSION, '/workspace', expected.needing);

        expect(scan.scannedWindowCount).toBe(expected.windows.length);
        expect(scan.scannedWindowCount).toBeGreaterThan(500);
        expect(scan.dedupedWindowCount).toBe(expected.deduped.length);
        // never 1, timed 2, edge 1 (completed), better 2, long 1 (completed),
        // short 2, stale 1 (started), tie 4. Nothing from the earlier hours.
        expect(scan.retainedWindowCount).toBe(14);
        // Each kept window is the one dedup chose, with the same payload (args
        // filled where dedup filled them), in dedup order.
        const key = (w: ToolCallWindow) => `${w.messageId}:${w.toolCallItemId}`;
        const kept = new Set(scan.windows.map(key));
        expect(scan.windows).toEqual(expected.deduped.filter(w => kept.has(key(w))));
        const scoring = expected.deduped.filter(w => expected.needing.some(f =>
          (scoreMatch(f.file_path, Number(f.timestamp_ms), w, f.metadata.toolUseId as string | undefined)?.score ?? 0) >= 30));
        expect(scoring.map(key).filter(k => !kept.has(k))).toEqual([]);
        // Only the two long tools' started rows were re-read, for their args.
        expect(log.rereads).toEqual([ids.edgeStarted, ids.longStarted]);

        // matchSession takes this path: it re-reads the same two rows.
        log.rereads.length = 0;
        await toolCallMatcher.matchSession(SESSION);
        expect(log.rereads).toEqual([ids.edgeStarted, ids.longStarted]);
        expect(log.inserts).toEqual(expected.inserts);
      });

      it('writes nothing when a started row it re-reads has gone, and the next pass matches', async () => {
        const { tables, ids } = longSessionTables(SESSION);
        const expected = writesOfScanEverything(SESSION, tables);
        const { log, vanished } = stubMatchTables({ [SESSION]: tables });
        vanished.add(ids.longStarted);

        await expect(toolCallMatcher.matchSession(SESSION)).resolves.toBe(0);
        expect(log.inserts).toEqual([]);
        expect(log.deletedMatches).toEqual([]);
        expect(log.deletedFiles).toEqual([]);

        vanished.clear();
        await expect(toolCallMatcher.matchSession(SESSION)).resolves.toBe(7);
        expect(log.inserts).toEqual(expected.inserts);
        expect(log.deletedMatches).toEqual(expected.deletedMatches);
        expect(log.deletedFiles).toEqual(expected.deletedFiles);
      });
    });
  });

  // SQLite stores session_files.metadata as TEXT and hands it back unparsed;
  // PGLite hands back an object. matchSession has to read both the same way.
  describe('matchSession session_files metadata on both backends', () => {
    const queryMock = database.query as ReturnType<typeof vi.fn>;
    const T0 = 1_700_000_000_000;
    const asSQLite = (metadata: Record<string, unknown>) => JSON.stringify(metadata);

    type FileRow = { id: string; file_path: string; timestamp_ms: number; metadata: unknown };
    type MessageRow = { id: number; created_at_ms: number; metadata: null; content: string };

    function toolUseMessage(id: number, createdAtMs: number, toolUseId: string, filePath: string): MessageRow {
      return {
        id,
        created_at_ms: createdAtMs,
        metadata: null,
        content: JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', id: toolUseId, name: 'Edit', input: { file_path: filePath } }] },
        }),
      };
    }

    function textMessage(id: number, createdAtMs: number): MessageRow {
      return {
        id,
        created_at_ms: createdAtMs,
        metadata: null,
        content: JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } }),
      };
    }

    /**
     * Stateful SQL-dispatch fake. Matches one pass writes are read back by the
     * next pass, session_files deletes take effect, and the raw-message read
     * honours the optional created_at bounds and the keyset paging (`id > $n`
     * cursor, `LIMIT $n`) so each scan's work can be counted: a scan is a read
     * from cursor 0, bounded when its SQL carries the created_at bounds, and
     * every row any page returns counts as scanned.
     */
    function fakeSessionDb(files: FileRow[], messages: MessageRow[]) {
      const matches: Array<{ session_file_id: string; message_id: number; tool_use_id: string | null; match_score: number }> = [];
      const stats = { scans: 0, boundedScans: 0, rowsScanned: 0, deletedFileIds: [] as string[] };
      queryMock.mockImplementation(async (sql: string, params: unknown[] = []) => {
        if (/^\s*DELETE FROM session_files/i.test(sql)) {
          const ids = params[0] as string[];
          stats.deletedFileIds.push(...ids);
          for (const id of ids) {
            const index = files.findIndex(f => f.id === id);
            if (index >= 0) files.splice(index, 1);
          }
          return { rows: [] };
        }
        if (/^\s*DELETE FROM ai_tool_call_file_edits/i.test(sql)) {
          const ids = new Set(params[1] as string[]);
          for (let i = matches.length - 1; i >= 0; i--) if (ids.has(matches[i].session_file_id)) matches.splice(i, 1);
          return { rows: [] };
        }
        if (/^\s*INSERT INTO ai_tool_call_file_edits/i.test(sql)) {
          for (let i = 0; i < params.length; i += 8) {
            const [, sessionFileId, messageId, , toolUseId, score] = params.slice(i, i + 8) as [string, string, number, unknown, string | null, number];
            const existing = matches.find(m => m.session_file_id === sessionFileId && m.message_id === messageId);
            if (existing) existing.match_score = score;
            else matches.push({ session_file_id: sessionFileId, message_id: messageId, tool_use_id: toolUseId, match_score: score });
          }
          return { rows: [] };
        }
        // A Claude Code session: the provider whose tool_use ids can be definitive.
        if (sql.includes('FROM ai_sessions')) return { rows: [{ workspace_id: '/workspace', provider: 'claude-code' }] };
        if (sql.includes('FROM session_files')) return { rows: files.map(f => ({ ...f })) };
        if (sql.includes('FROM ai_tool_call_file_edits')) return { rows: matches.map(m => ({ ...m })) };
        if (sql.includes('FROM ai_agent_messages')) {
          const param = (pattern: RegExp) => {
            const ref = pattern.exec(sql);
            return ref ? params[Number(ref[1]) - 1] : undefined;
          };
          const byId = param(/\bid\s*=\s*\$(\d+)/);
          if (byId !== undefined) {
            const rows = messages.filter(m => m.id === Number(byId));
            stats.rowsScanned += rows.length;
            return { rows };
          }
          const cursor = Number(param(/\bid\s*>\s*\$(\d+)/));
          const limit = Number(param(/\bLIMIT\s+\$(\d+)/i));
          const after = param(/>=\s*\$(\d+)/) as number | undefined;
          const before = param(/<=\s*\$(\d+)/) as number | undefined;
          if (cursor === 0) {
            stats.scans++;
            if (after !== undefined || before !== undefined) stats.boundedScans++;
          }
          const rows = [...messages]
            .sort((a, b) => a.id - b.id)
            .filter(m => m.id > cursor
              && (after === undefined || m.created_at_ms >= after)
              && (before === undefined || m.created_at_ms <= before))
            .slice(0, limit);
          stats.rowsScanned += rows.length;
          return { rows };
        }
        return { rows: [] };
      });
      return { matches, stats };
    }

    beforeEach(() => {
      vi.mocked(logger.main.error).mockClear();
    });

    it('settles a file whose JSON-string metadata carries its toolUseId, so the next pass skips the scan', async () => {
      // The tool call names the file 2s before the edit, so without the id the
      // best the heuristics reach is 40 (name_in_args): never settled, and
      // every later pass rescans.
      const { matches, stats } = fakeSessionDb(
        [{ id: 'f1', file_path: '/workspace/src/a.ts', timestamp_ms: T0, metadata: asSQLite({ toolUseId: 't1' }) }],
        [toolUseMessage(7, T0 - 2_000, 't1', '/workspace/src/a.ts')],
      );

      await expect(toolCallMatcher.matchSession('sqlite-settle')).resolves.toBe(1);
      await expect(toolCallMatcher.matchSession('sqlite-settle')).resolves.toBe(0);

      expect(matches).toEqual([{ session_file_id: 'f1', message_id: 7, tool_use_id: 't1', match_score: 100 }]);
      expect(stats.scans).toBe(1);
    });

    it('keeps each tool call\'s edit of the same file when the metadata is a JSON string', async () => {
      // Rows with distinct toolUseIds are separate edits. Without the id they
      // collapse to the newest row per path and the older edit is never matched.
      const { matches } = fakeSessionDb(
        [
          { id: 'f1', file_path: '/workspace/src/a.ts', timestamp_ms: T0, metadata: asSQLite({ toolUseId: 't1' }) },
          { id: 'f2', file_path: '/workspace/src/a.ts', timestamp_ms: T0 + 30_000, metadata: asSQLite({ toolUseId: 't2' }) },
        ],
        [
          toolUseMessage(1, T0 - 1_000, 't1', '/workspace/src/a.ts'),
          toolUseMessage(2, T0 + 29_000, 't2', '/workspace/src/a.ts'),
        ],
      );

      await expect(toolCallMatcher.matchSession('sqlite-same-file')).resolves.toBe(2);

      expect(matches).toEqual([
        { session_file_id: 'f1', message_id: 1, tool_use_id: 't1', match_score: 100 },
        { session_file_id: 'f2', message_id: 2, tool_use_id: 't2', match_score: 100 },
      ]);
    });

    it.each([
      ['object (PGLite)', (metadata: Record<string, unknown>) => metadata],
      ['JSON string (SQLite)', asSQLite],
    ])('removes unmatched bash side-effect rows and keeps matched ones, metadata as %s', async (_shape, shape) => {
      const { matches, stats } = fakeSessionDb(
        [
          { id: 'bash-matched', file_path: '/workspace/src/kept.ts', timestamp_ms: T0, metadata: shape({ bashSideEffect: true }) },
          { id: 'bash-orphan', file_path: '/workspace/out/generated.txt', timestamp_ms: T0, metadata: shape({ bashSideEffect: true }) },
        ],
        [toolUseMessage(3, T0 - 1_000, 't-other', '/workspace/src/kept.ts')],
      );

      await expect(toolCallMatcher.matchSession('bash-cleanup')).resolves.toBe(1);

      expect(matches.map(m => m.session_file_id)).toEqual(['bash-matched']);
      expect(stats.deletedFileIds).toEqual(['bash-orphan']);
    });

    it('treats empty, invalid or non-object JSON metadata as no metadata without failing the pass', async () => {
      const { stats } = fakeSessionDb(
        ['', 'not json', '{"toolUseId":', 'null', '"t1"', '[{"toolUseId":"t1"}]'].map((metadata, i) => ({
          id: `bad-${i}`,
          file_path: `/workspace/src/bad-${i}.ts`,
          timestamp_ms: T0 + i,
          metadata,
        })),
        [],
      );

      await expect(toolCallMatcher.matchSession('bad-metadata')).resolves.toBe(0);

      expect(logger.main.error).not.toHaveBeenCalled();
      // No definitive id survives, so the lookup stays bounded to the edits.
      expect(stats).toEqual({ scans: 1, boundedScans: 1, rowsScanned: 0, deletedFileIds: [] });
    });

    it('N3: an invalid metadata row does not fail the session diff context', async () => {
      fakeSessionDb(
        [
          { id: 'n3-bad', file_path: '/workspace/src/bad.ts', timestamp_ms: T0, metadata: '{"toolUseId":' },
          { id: 'n3-ok', file_path: '/workspace/src/ok.ts', timestamp_ms: T0, metadata: asSQLite({ toolUseId: 'n3-tool' }) },
        ],
        [],
      );

      const ctx = await toolCallMatcher.createSessionEnrichmentContext('n3-context');

      expect([...ctx.editedByToolUseId.keys()]).toEqual(['n3-tool']);
      expect(ctx.sessionFilesById.get('n3-bad')).toEqual({ file_path: '/workspace/src/bad.ts', metadata: {} });
    });

    it('N3: an invalid metadata row does not fail the per-call diff lookup', async () => {
      queryMock.mockImplementation(async (sql: string) => {
        if (sql.includes("metadata->>'toolUseId'")) return { rows: [] }; // no direct session_files link
        if (/SELECT message_id\s+FROM ai_tool_call_file_edits/.test(sql)) return { rows: [{ message_id: 9 }] };
        if (sql.includes('FROM ai_tool_call_file_edits')) {
          return { rows: [{ session_file_id: 'n3-bad', message_id: 9, match_reason: 'name_in_args' }] };
        }
        if (sql.includes('FROM session_files')) {
          return { rows: [{ id: 'n3-bad', file_path: '/workspace/src/bad.ts', metadata: 'not json' }] };
        }
        return { rows: [] };
      });

      const diffs = await toolCallMatcher.getDiffsForToolCall('n3-per-call', 'n3-call');

      expect(diffs.map(d => [d.filePath, d.operation])).toEqual([['/workspace/src/bad.ts', 'edit']]);
      expect(logger.main.error).not.toHaveBeenCalled();
    });

    /**
     * Raw-message scan work over a session that grows one edit at a time, with
     * PASSES_PER_EDIT matchSession passes after each edit (the edit's own tool
     * call, later non-edit tool calls, end of turn). Each edit's tool call
     * names its file 500ms before the edit, so heuristics alone score it 40.
     */
    function runGrowingSession(fileToolUseId: (edit: number) => string) {
      const LEAD_ROWS = 20; // history before the first edit
      const FILLER_ROWS_PER_TURN = 10;
      const EDITS = 5;
      const PASSES_PER_EDIT = 4;
      const files: FileRow[] = [];
      const messages: MessageRow[] = [];
      let nextId = 1;
      for (let i = 0; i < LEAD_ROWS; i++) messages.push(textMessage(nextId++, T0 + i * 1_000));
      const db = fakeSessionDb(files, messages);
      return (async () => {
        for (let edit = 1; edit <= EDITS; edit++) {
          const turnStart = T0 + edit * 60_000;
          for (let i = 0; i < FILLER_ROWS_PER_TURN; i++) messages.push(textMessage(nextId++, turnStart + i * 1_000));
          const filePath = `/workspace/src/file-${edit}.ts`;
          messages.push(toolUseMessage(nextId++, turnStart + 10_000, `t${edit}`, filePath));
          files.push({ id: `f${edit}`, file_path: filePath, timestamp_ms: turnStart + 10_500, metadata: asSQLite({ toolUseId: fileToolUseId(edit) }) });
          for (let pass = 0; pass < PASSES_PER_EDIT; pass++) await toolCallMatcher.matchSession('growing-session');
        }
        return {
          scans: db.stats.scans,
          boundedScans: db.stats.boundedScans,
          rowsScanned: db.stats.rowsScanned,
          scores: db.matches.map(m => m.match_score),
        };
      })();
    }

    // Rows in the session when edit k lands: 20 lead rows plus 11 per turn.
    const sessionRowsAtEdit = (k: number) => 20 + 11 * k;
    const sumOverEdits = (f: (k: number) => number) => [1, 2, 3, 4, 5].reduce((sum, k) => sum + f(k), 0);

    it('scan work, every toolUseId resolvable: one whole-session scan per new edit, none once settled', async () => {
      const measured = await runGrowingSession(edit => `t${edit}`);
      expect(measured).toEqual({
        scans: 5,
        boundedScans: 0,
        rowsScanned: sumOverEdits(sessionRowsAtEdit), // 265
        scores: [100, 100, 100, 100, 100],
      });
    });

    it('scan work, one toolUseId never resolvable: every pass scans the whole session, as on PGLite', async () => {
      // The first edit's id matches no tool call, so that file never settles
      // and keeps the unbounded lookup that exact ids require.
      const measured = await runGrowingSession(edit => (edit === 1 ? 'ghost' : `t${edit}`));
      expect(measured).toEqual({
        scans: 20,
        boundedScans: 0,
        rowsScanned: 4 * sumOverEdits(sessionRowsAtEdit), // 1060
        scores: [40, 100, 100, 100, 100],
      });
    });

    it.each(['nimtc|call_', 'watcher-', 'codex-bash-', 'codex-acp-write-'])(
      'B1: scan work, ids Nimbalyst minted (%s): only bounded scans, as before SQLite metadata was read',
      async prefix => {
        // A minted id is no provider tool-call id, so it does not justify a
        // whole-session read. Each pass reads from 10s before the first edit to
        // 10s after the latest: 11 rows per turn, less turn 1's opening row.
        const measured = await runGrowingSession(edit => `${prefix}${edit}`);
        expect(measured).toEqual({
          scans: 20,
          boundedScans: 20,
          rowsScanned: 4 * sumOverEdits(k => 11 * k - 1), // 640
          scores: [40, 40, 40, 40, 40],
        });
      },
    );

    describe('against a real SQLite database', () => {
      let tmp: string;
      let sqlite: SQLiteDatabase;

      beforeEach(async () => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-toolcall-metadata-'));
        const dbDir = path.join(tmp, 'sqlite-db');
        fs.mkdirSync(dbDir, { recursive: true });
        sqlite = new SQLiteDatabase({ dbDir, schemaDir: path.resolve(__dirname, '../../database/sqlite/schemas') });
        await sqlite.initialize();
      });

      afterEach(async () => {
        try { await sqlite.close(); } catch { /* ignore */ }
        fs.rmSync(tmp, { recursive: true, force: true });
      });

      it('matches by toolUseId, removes the orphaned bash side effect, and skips the scan on the next pass', async () => {
        const sessionId = 'sqlite-real-session';
        const fileTs = T0;
        await sqlite.query(
          `INSERT INTO ai_sessions (id, workspace_id, provider) VALUES ($1, $2, $3)`,
          [sessionId, '/workspace', 'claude-code'],
        );
        // Written through the production session_files store.
        const store = createPGLiteSessionFileStore(sqlite);
        const edited = await store.addFileLink({
          sessionId,
          workspaceId: '/workspace',
          filePath: '/workspace/src/kept.ts',
          linkType: 'edited',
          timestamp: fileTs,
          metadata: { toolName: 'Edit', operation: 'edit', toolUseId: 'toolu_exact' },
        });
        const orphan = await store.addFileLink({
          sessionId,
          workspaceId: '/workspace',
          filePath: '/workspace/out/generated.txt',
          linkType: 'edited',
          timestamp: fileTs,
          metadata: { bashSideEffect: true },
        });
        // The tool call is 60s before the edit: reachable only through the exact id.
        await sqlite.query(
          `INSERT INTO ai_agent_messages (session_id, created_at, source, direction, content) VALUES ($1, $2, $3, $4, $5)`,
          [
            sessionId,
            new Date(fileTs - 60_000).toISOString(),
            'claude-code',
            'output',
            JSON.stringify({
              type: 'assistant',
              message: { content: [{ type: 'tool_use', id: 'toolu_exact', name: 'Edit', input: { file_path: '/workspace/src/kept.ts' } }] },
            }),
          ],
        );

        // Premise: SQLite returns the column as JSON text, not an object.
        const raw = await sqlite.query<{ metadata: unknown }>(`SELECT metadata FROM session_files WHERE id = $1`, [edited.id]);
        expect(typeof raw.rows[0].metadata).toBe('string');

        const sqlSeen: string[] = [];
        queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
          sqlSeen.push(sql);
          return sqlite.query(sql, params);
        });

        await expect(toolCallMatcher.matchSession(sessionId)).resolves.toBe(1);
        expect(logger.main.error).not.toHaveBeenCalled();

        const stored = await sqlite.query(
          `SELECT session_file_id, tool_use_id, match_score FROM ai_tool_call_file_edits WHERE session_id = $1`,
          [sessionId],
        );
        expect(stored.rows).toEqual([{ session_file_id: edited.id, tool_use_id: 'toolu_exact', match_score: 100 }]);
        const remaining = await sqlite.query<{ id: string }>(`SELECT id FROM session_files WHERE session_id = $1`, [sessionId]);
        // The orphaned bash side effect is gone; the matched edit stays.
        expect(orphan.id).not.toBe(edited.id);
        expect(remaining.rows.map(r => r.id)).toEqual([edited.id]);

        sqlSeen.length = 0;
        await expect(toolCallMatcher.matchSession(sessionId)).resolves.toBe(0);
        expect(sqlSeen.some(sql => sql.includes('FROM ai_agent_messages'))).toBe(false);
      });

      /**
       * Counts the raw-message reads matchSession makes against the real
       * database. A scan is a keyset walk from cursor 0 and `pages` its reads;
       * a scan is unbounded when its SQL carries no created_at bound. Every row
       * any read returns counts as scanned.
       */
      function countRawScans() {
        const stats = { scans: 0, pages: 0, unboundedScans: 0, rowsScanned: 0 };
        queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
          const result = await sqlite.query(sql, params);
          if (sql.includes('FROM ai_agent_messages')) {
            const cursorRef = /\bid\s*>\s*\$(\d+)/.exec(sql);
            if (cursorRef) {
              stats.pages++;
              if (Number(params?.[Number(cursorRef[1]) - 1]) === 0) {
                stats.scans++;
                if (!/[<>]=\s*\$\d+/.test(sql)) stats.unboundedScans++;
              }
            }
            stats.rowsScanned += result.rows.length;
          }
          return result;
        });
        return stats;
      }

      // One task over five turns (explore, edit, verify); a.ts is edited twice.
      const TURNS = [
        { explore: 12, edits: ['/workspace/src/a.ts', '/workspace/src/b.ts'], verify: 4 },
        { explore: 6, edits: ['/workspace/src/a.ts'], verify: 3 },
        { explore: 8, edits: [] as string[], verify: 0 },
        { explore: 5, edits: ['/workspace/src/c.ts'], verify: 3 },
        { explore: 10, edits: [] as string[], verify: 0 },
      ];

      async function expectNoMatchesOrErrors(sessionId: string) {
        const stored = await sqlite.query(`SELECT id FROM ai_tool_call_file_edits WHERE session_id = $1`, [sessionId]);
        expect(stored.rows).toEqual([]);
        expect(logger.main.error).not.toHaveBeenCalled();
      }

      /**
       * Replays a Codex session on the app-server transport, running
       * matchSession where the app does (after each tool call and at the end of
       * each turn), and counts the raw rows each pass reads. Rows are shaped as
       * OpenAICodexProvider stores them ({method, params} content), apply_patch
       * edits as SessionFileTracker writes them (toolUseId = the nimtc|
       * edit-group id) and, with `shellWrite`, the files one shell command
       * changes as the Codex shell hook writes them (toolUseId = Codex's own
       * call id). No row on this transport yields a window, so nothing settles.
       */
      async function replayCodexAppServer(sessionId: string, shellWrite?: { turn: number; beforeExplore: number; files: string[] }) {
        await sqlite.query(`INSERT INTO ai_sessions (id, workspace_id, provider) VALUES ($1, $2, $3)`, [sessionId, '/workspace', 'openai-codex']);
        const store = createPGLiteSessionFileStore(sqlite);
        const stats = countRawScans();

        let t = T0;
        let item = 0;
        const row = async (method: string, body: Record<string, unknown>, turnId: string, editGroupId?: string) => {
          t += 3_000;
          await sqlite.query(
            `INSERT INTO ai_agent_messages (session_id, created_at, source, direction, content, metadata) VALUES ($1, $2, $3, $4, $5, $6)`,
            [sessionId, new Date(t).toISOString(), 'openai-codex', 'output',
              JSON.stringify({ method, params: { threadId: 'thr-1', turnId, item: body } }),
              JSON.stringify({ eventType: method, codexProvider: true, transport: 'app-server', ...(editGroupId ? { editGroupId } : {}) })],
          );
        };
        const command = async (turnId: string, cmd: string, writes: string[] = []) => {
          const id = `call_${++item}`;
          const editGroupId = `nimtc|${id}|${t}|${item}`;
          await row('item/completed', { type: 'reasoning', id: `rs_${item}`, summary: ['Looking at the code'], content: [] }, turnId);
          await row('item/started', { type: 'commandExecution', id, command: cmd, status: 'inProgress' }, turnId, editGroupId);
          for (const filePath of writes) {
            await store.addFileLink({
              sessionId, workspaceId: '/workspace', filePath, linkType: 'edited', timestamp: t + 500,
              metadata: { toolName: 'Bash', operation: 'bash', toolUseId: id, source: 'shell-hook-inferred' },
            });
          }
          await row('item/completed', { type: 'commandExecution', id, command: cmd, aggregatedOutput: 'output\n', exitCode: 0, status: 'completed' }, turnId, editGroupId);
          await toolCallMatcher.matchSession(sessionId);
        };
        for (const [k, turn] of TURNS.entries()) {
          const turnId = `turn-${k}`;
          for (let i = 0; i < turn.explore; i++) {
            if (shellWrite?.turn === k && shellWrite.beforeExplore === i) await command(turnId, 'pnpm add zod', shellWrite.files);
            await command(turnId, `rg -n thing src/file${i}.ts`);
          }
          for (const filePath of turn.edits) {
            const id = `call_${++item}`;
            const editGroupId = `nimtc|${id}|${t}|${item}`;
            await row('item/completed', { type: 'fileChange', id, status: 'completed', changes: [{ path: filePath, kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-a\n+b\n' }] }, turnId, editGroupId);
            await store.addFileLink({ sessionId, workspaceId: '/workspace', filePath, linkType: 'edited', timestamp: t, metadata: { toolName: 'file_change', operation: 'edit', toolUseId: editGroupId } });
            await toolCallMatcher.matchSession(sessionId);
          }
          for (let i = 0; i < turn.verify; i++) await command(turnId, 'pnpm test');
          await row('item/completed', { type: 'agentMessage', id: `msg_${k}`, text: 'Done.' }, turnId);
          await row('turn/completed', { id: turnId }, turnId);
          await toolCallMatcher.matchSession(sessionId); // end of turn
          t += 60_000; // the user reads and answers
        }

        await expectNoMatchesOrErrors(sessionId);
        return stats;
      }

      it('B1: a Codex app-server session reads no more raw rows than before SQLite metadata was read', async () => {
        // Before SQLite metadata was read (70bb210b6, which reads in pages), the
        // same replay made 48 bounded scans, in 48 pages, of 2339 rows in total
        // (the parse alone made them unbounded: 4856 rows).
        await expect(replayCodexAppServer('b1-codex-app-server')).resolves.toEqual({ scans: 48, pages: 48, unboundedScans: 0, rowsScanned: 2339 });
      });

      it('B3: a Codex app-server session where a shell command changes files reads no more raw rows than before', async () => {
        // The shell-hook rows carry Codex's own call id, which no window on this
        // transport carries. Before SQLite metadata was read (70bb210b6), the
        // replay made 59 bounded scans, in 75 pages, of 3985 rows; counting that
        // id as definitive made every one of them a whole-session read (5264 rows).
        await expect(replayCodexAppServer('b3-codex-shell-write', {
          turn: 0, beforeExplore: 2, files: ['/workspace/package.json', '/workspace/pnpm-lock.yaml'],
        })).resolves.toEqual({ scans: 59, pages: 75, unboundedScans: 0, rowsScanned: 3985 });
      });

      it('B4: a cursor-agent session reads no more raw rows than before SQLite metadata was read', async () => {
        // Cursor stores every stream-json record as a visible row (thinking
        // deltas, tool_call started/completed with its call_id, results). None
        // yields a window, so the call ids its edits record never resolve.
        const sessionId = 'b4-cursor-agent';
        await sqlite.query(`INSERT INTO ai_sessions (id, workspace_id, provider) VALUES ($1, $2, $3)`, [sessionId, '/workspace', 'cursor-agent']);
        const store = createPGLiteSessionFileStore(sqlite);
        const stats = countRawScans();
        let t = T0;
        let n = 0;
        const row = (record: Record<string, unknown>, at = t) => sqlite.query(
          `INSERT INTO ai_agent_messages (session_id, created_at, source, direction, content, metadata) VALUES ($1, $2, $3, $4, $5, $6)`,
          [sessionId, new Date(at).toISOString(), 'cursor-agent', 'output', JSON.stringify(record), JSON.stringify({ eventType: record.type })],
        );
        const call = async (tool: string, args: Record<string, unknown>) => {
          t += 3_000;
          for (let i = 0; i < 5; i++) await row({ type: 'thinking', subtype: i < 4 ? 'delta' : 'completed', text: 'Looking' });
          const id = `tool_${++n}`;
          await row({ type: 'tool_call', subtype: 'started', call_id: id, tool_call: { [tool]: { args } } });
          await row({ type: 'tool_call', subtype: 'completed', call_id: id, tool_call: { [tool]: { args, result: { success: {} } } } }, t + 500);
          return id;
        };
        for (const [k, turn] of TURNS.entries()) {
          t += 1_000;
          await row({ type: 'system', subtype: 'init', cwd: '/workspace' });
          await row({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: `Task step ${k}` }] } });
          for (let i = 0; i < turn.explore; i++) {
            await call(i % 2 ? 'readToolCall' : 'grepToolCall', { path: `/workspace/src/file${i}.ts` });
            await toolCallMatcher.matchSession(sessionId);
          }
          for (const filePath of turn.edits) {
            const id = await call('editToolCall', { path: filePath });
            await store.addFileLink({ sessionId, workspaceId: '/workspace', filePath, linkType: 'edited', timestamp: t, metadata: { toolName: 'edit', toolUseId: id } });
            await toolCallMatcher.matchSession(sessionId);
          }
          for (let i = 0; i < turn.verify; i++) {
            await call('shellToolCall', { command: 'pnpm test' });
            await toolCallMatcher.matchSession(sessionId);
          }
          t += 2_000;
          await row({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } });
          await row({ type: 'result', subtype: 'success', result: 'Done.' });
          await row({ type: 'item.completed', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] } });
          await toolCallMatcher.matchSession(sessionId); // end of turn
          t += 60_000;
        }

        await expectNoMatchesOrErrors(sessionId);
        // Before SQLite metadata was read (70bb210b6), the same replay made 48
        // bounded scans, in 99 pages, of 7223 rows; counting Cursor's call ids as
        // definitive made every one of them a whole-session read (12134 rows).
        expect(stats).toEqual({ scans: 48, pages: 99, unboundedScans: 0, rowsScanned: 7223 });
      });

      it('B2: the per-call diff of a Write that created a file reports create on SQLite', async () => {
        const sessionId = 'b2-diff-operation';
        await sqlite.query(`INSERT INTO ai_sessions (id, workspace_id, provider) VALUES ($1, $2, $3)`, [sessionId, '/workspace', 'claude-code']);
        await createPGLiteSessionFileStore(sqlite).addFileLink({
          sessionId,
          workspaceId: '/workspace',
          filePath: '/workspace/src/new.ts',
          linkType: 'edited',
          timestamp: T0,
          metadata: { toolName: 'Write', operation: 'create', toolUseId: 'toolu_b2_write' },
        });
        queryMock.mockImplementation((sql: string, params?: unknown[]) => sqlite.query(sql, params));
        AISessionsRepository.setStore({ get: async () => ({ provider: 'claude-code' }) } as unknown as Parameters<typeof AISessionsRepository.setStore>[0]);
        const hasService = vi.spyOn(TranscriptMigrationRepository, 'hasService').mockReturnValue(true);
        const getService = vi.spyOn(TranscriptMigrationRepository, 'getService').mockReturnValue({
          findToolCallByProviderId: async (_session: string, id: string) => (id === 'toolu_b2_write'
            ? { payload: { toolName: 'Write', arguments: { file_path: '/workspace/src/new.ts', content: 'export const x = 1;\n' } } }
            : null),
        } as unknown as ReturnType<typeof TranscriptMigrationRepository.getService>);
        try {
          const result = await toolCallMatcher.getDiffsForToolCallResult(sessionId, 'toolu_b2_write');

          expect(result.diffs.map(d => [d.filePath, d.operation, d.content])).toEqual([
            ['/workspace/src/new.ts', 'create', 'export const x = 1;\n'],
          ]);
        } finally {
          hasService.mockRestore();
          getService.mockRestore();
          AISessionsRepository.clearStore();
        }
      });
    });
  });
});
