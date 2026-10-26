// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  target: vi.fn(async (): Promise<any> => null),
  emit: vi.fn(),
  commit: vi.fn(async () => ({ success: true, commitHash: 'abc' })),
  waiters: 1,
  states: new Map<string, { status: string }>(),
  queued: new Map<string, any>(),
  endSession: vi.fn(async () => {}),
}));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] }, ipcMain: { emit: mocks.emit, listenerCount: () => mocks.waiters } }));
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({ AISessionsRepository: { get: async () => ({ provider: 'claude-code', workspacePath: '/main' }) } }));
vi.mock('@nimbalyst/runtime/ai/server', () => ({ ProviderFactory: { getProvider: () => undefined } }));
vi.mock('@nimbalyst/runtime/ai/server/SessionStateManager', () => ({
  getSessionStateManager: () => ({ getSessionState: (id: string) => mocks.states.get(id) ?? null, endSession: mocks.endSession }),
}));
vi.mock('../../RepositoryManager', () => ({
  getQueuedPromptsStore: () => ({
    get: async (id: string) => mocks.queued.get(id) ?? null,
    create: async (row: { id: string }) => { mocks.queued.set(row.id, row); return row; },
  }),
}));
vi.mock('@nimbalyst/runtime/storage/repositories/AgentMessagesRepository', () => ({ AgentMessagesRepository: { create: async () => {} } }));
vi.mock('../../../utils/logger', () => ({ logger: { ai: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } } }));
vi.mock('../../../tray/TrayManager', () => ({ TrayManager: { getInstance: () => ({ onPromptResolved: vi.fn() }) } }));
vi.mock('../gitCommitProposalPromptUtils', () => ({
  getGitCommitProposalResponseChannel: () => 'channel',
  resolveGitCommitProposalPromptId: async (_s: string, id: string) => id,
  findGitCommitProposalWorktreeTarget: mocks.target,
}));
vi.mock('../../gitEnv', () => ({ getGitSubprocessEnv: () => ({}) }));
vi.mock('../../SessionCommitService', () => ({ SessionCommitService: { getInstance: () => ({ recordCommit: async () => {} }) } }));
vi.mock('../../../database/initialize', () => ({ getDatabase: () => null }));
vi.mock('../../WorktreeStore', () => ({ createWorktreeStore: () => ({}) }));
vi.mock('../../GitCommitService', () => ({
  executeGitCommitAcrossRepos: mocks.commit,
  createGitCommitProposalResponse: () => ({ action: 'committed', commitHash: 'abc' }),
}));
vi.mock('../../workspaceRepos', () => ({ resolveExtraCommitRoots: () => [] }));
vi.mock('../CommitProposalExecution', () => ({
  runCommitProposalOnce: async (_s: string, _p: string, _i: string, run: () => Promise<unknown>) => run(),
  commitProposalIdentity: () => 'identity',
  cancelCommitProposalOnce: async () => true,
  acceptsCommitProposalResponse: () => true,
}));

import { handleGitCommitResponse } from '../MobileGitCommitResponse';
import { configureAnswerResume } from '../answerResume';
import { isCommitProposalExecuting } from '@nimbalyst/runtime/ai/server/commitProposalInFlight';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.target.mockResolvedValue(null);
  mocks.waiters = 1;
  mocks.states.clear();
  mocks.queued.clear();
});

// #1756: mobile cannot show the target branch and path, so it must not approve a sibling-worktree commit.
it('refuses a sibling-worktree commit from mobile without closing the desktop proposal', async () => {
  mocks.target.mockResolvedValue({ path: '/main_worktrees/feature', branch: 'feature' });
  const result = await handleGitCommitResponse('session', 'proposal', { action: 'committed', files: ['/main_worktrees/feature/a.txt'], message: 'fix: x' }, () => null);
  expect(result).toMatchObject({ action: 'error', error: expect.stringContaining('desktop') });
  expect(mocks.commit).not.toHaveBeenCalled();
  expect(mocks.emit).not.toHaveBeenCalled();
});

it('still commits an ordinary proposal from mobile', async () => {
  const result = await handleGitCommitResponse('session', 'proposal', { action: 'committed', files: ['/main/a.txt'], message: 'fix: x' }, () => null);
  expect(result.action).toBe('committed');
  expect(mocks.commit).toHaveBeenCalled();
});

// Round 2 review: mobile's Confirm awaits the proposal lookup and paths before
// the commit marks itself; the hold starts when the Confirm arrives.
it("holds the proposal from the moment mobile's Confirm arrives, and not for a cancel", async () => {
  const pending = handleGitCommitResponse('session', 'proposal', { action: 'committed', files: ['/main/a.txt'], message: 'fix: x' }, () => null);
  expect(isCommitProposalExecuting('session', 'proposal')).toBe(true);
  await pending;
  expect(isCommitProposalExecuting('session', 'proposal')).toBe(false);

  const cancelling = handleGitCommitResponse('session', 'proposal', { action: 'cancelled' }, () => null);
  expect(isCommitProposalExecuting('session', 'proposal')).toBe(false);
  await cancelling;
});

// Round 4: a released (#1116) or orphaned proposal has no MCP waiter. Mobile's
// Confirm still commits, and the agent hears the outcome the way the desktop
// path tells it: queued while a turn is in flight, at once when idle.
describe('a mobile Confirm on a proposal with no MCP waiter', () => {
  const host = { send: vi.fn(async () => undefined), publish: vi.fn(async () => {}), drive: vi.fn(async () => undefined) };
  const window = { isDestroyed: () => false, webContents: { mainFrame: {} } };
  const confirm = () => handleGitCommitResponse('session', 'proposal', { action: 'committed', files: ['/main/a.txt'], message: 'fix: x' }, () => window as any);
  const queuedPrompts = () => [...mocks.queued.values()];

  beforeEach(() => {
    mocks.waiters = 0;
    configureAnswerResume(host);
  });

  it('queues the outcome while a turn is in flight and never idles that turn', async () => {
    mocks.states.set('session', { status: 'running' });

    expect(await confirm()).toMatchObject({ action: 'committed', commitHash: 'abc' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(mocks.endSession).not.toHaveBeenCalled();
    expect(host.send).not.toHaveBeenCalled();
    expect(queuedPrompts()).toEqual([expect.objectContaining({
      sessionId: 'session',
      prompt: expect.stringContaining('Commit hash: abc'),
      documentContext: { promptOrigin: 'interactive-question' },
    })]);
    expect(host.drive).toHaveBeenCalledWith('session', '/main');
  });

  it('resumes an idle agent with the commit hash', async () => {
    expect(await confirm()).toMatchObject({ action: 'committed', commitHash: 'abc' });

    await vi.waitFor(() => expect(host.send).toHaveBeenCalledTimes(1));
    expect(host.send).toHaveBeenCalledWith({
      event: expect.objectContaining({ sender: window.webContents }),
      sessionId: 'session',
      workspacePath: '/main',
      message: expect.stringContaining('Commit hash: abc'),
    });
    expect(queuedPrompts()).toEqual([]);
    expect(mocks.endSession).not.toHaveBeenCalled();
  });

  it('hands the outcome to a live waiter and does nothing else', async () => {
    mocks.waiters = 1;

    expect(await confirm()).toMatchObject({ action: 'committed', commitHash: 'abc' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(mocks.emit).toHaveBeenCalledWith('channel', null, expect.objectContaining({ commitHash: 'abc' }));
    expect(host.send).not.toHaveBeenCalled();
    expect(queuedPrompts()).toEqual([]);
    expect(mocks.endSession).not.toHaveBeenCalled();
  });
});
