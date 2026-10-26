// @vitest-environment node
/**
 * Session 723ddabd: the user answered an older, still-open Claude Code card
 * while a newer question was live. The answer had no waiter on its own channel,
 * so it went down the session fallback and settled the live question (a
 * different one); resubmitting then auto-resumed mid-turn and aborted it.
 * An answer belongs to its own card: with no live waiter for that card it
 * becomes the card's terminal result, and it never resumes over a live prompt.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require('node:events') as typeof import('node:events');
  return {
    ipcMain: new EventEmitter(),
    rows: [] as Array<{ sessionId: string; toolUseId: string; result: any }>,
    reservations: new Map<string, unknown>(),
    handlers: new Map<string, (...args: any[]) => any>(),
    provider: 'claude-code',
    providerInstance: undefined as undefined | { rejectAskUserQuestion: (...a: unknown[]) => void; abort: () => void },
    states: new Map<string, { status: string; isStreaming?: boolean }>(),
    queued: new Map<string, any>(),
    endSession: vi.fn(async () => {}),
  };
});

vi.mock('electron', () => ({ ipcMain: h.ipcMain }));
vi.mock('../../../utils/logger', () => ({ logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } }));
vi.mock('../../../mcp/tools/interactivePromptTranscript', () => ({
  persistInteractivePromptToolResult: vi.fn(async (a: { sessionId: string; toolUseId: string; result: any }) => { h.rows.push(a); }),
}));
vi.mock('../pendingPromptPersistence', () => ({ setSessionPendingPrompt: vi.fn(async () => {}) }));
vi.mock('../../../utils/privateSettingsStore', () => ({
  default: class {
    get(key: string) { return h.reservations.get(key); }
    set(key: string, value: unknown) { h.reservations.set(key, value); }
  },
}));
vi.mock('@nimbalyst/runtime/storage/repositories/AgentMessagesRepository', () => ({
  AgentMessagesRepository: { create: vi.fn(async () => undefined) },
}));
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: { get: vi.fn(async () => ({ provider: h.provider, workspacePath: '/ws' })) },
}));
vi.mock('@nimbalyst/runtime/ai/server', () => ({ ProviderFactory: { getProvider: () => h.providerInstance }, isAskUserQuestionProvider: () => false }));
vi.mock('../../../utils/ipcRegistry', () => ({ safeHandle: (channel: string, fn: (...args: any[]) => any) => h.handlers.set(channel, fn) }));
vi.mock('../../../database/PGLiteDatabaseWorker', () => ({ database: { query: vi.fn(async () => ({ rows: [] })) } }));
vi.mock('../CommitProposalExecution', () => ({ cancelCommitProposalOnce: vi.fn(async () => true), acceptsCommitProposalResponse: vi.fn(() => true) }));
vi.mock('../../SessionCommitService', () => ({ SessionCommitService: { getInstance: () => ({ recordCommit: vi.fn() }) } }));
vi.mock('@nimbalyst/runtime/ai/server/SessionStateManager', () => ({
  getSessionStateManager: () => ({ getSessionState: (id: string) => h.states.get(id) ?? null, endSession: h.endSession }),
}));
vi.mock('../../RepositoryManager', () => ({
  getQueuedPromptsStore: () => ({
    get: async (id: string) => h.queued.get(id) ?? null,
    create: async (row: { id: string }) => { h.queued.set(row.id, row); return row; },
  }),
}));
vi.mock('@nimbalyst/runtime/storage/repositories/TranscriptMigrationRepository', () => ({ TranscriptMigrationRepository: { hasService: () => false } }));
vi.mock('../../../tray/TrayManager', () => ({ TrayManager: { getInstance: () => ({ onPromptResolved: vi.fn() }) } }));
vi.mock('../../../mcp/tools/codexToolCallResolver', () => ({
  resolveRequestUserInputPromptTargets: (id: string) => ({ promptId: id, waiterPromptIds: [id] }),
}));
vi.mock('../gitCommitProposalPromptUtils', () => ({
  getGitCommitProposalResponseChannel: (sessionId: string, proposalId: string) => `git-commit-proposal-response:${sessionId}:${proposalId}`,
  resolveGitCommitProposalPromptId: async (_sessionId: string, proposalId: string) => proposalId,
}));
vi.mock('../codexQuestionDelivery', () => ({ deliverCodexQuestionAnswer: vi.fn(), configureCodexQuestionDelivery: vi.fn() }));
vi.mock('../../SyncManager', () => ({ getSyncProvider: () => null }));

import { registerSessionPromptResponseHandler } from '../../../ipc/sessionPromptResponseHandler';
import { registerAskUserQuestionAnswerHandler } from '../ipc/registerAskUserQuestionAnswerHandler';
import { configureAnswerResume } from '../answerResume';
import { registerInteractivePromptHandlers } from '../ipc/registerInteractivePromptHandlers';
import { clearLiveInteractivePrompt, noteLiveInteractivePrompt } from '../../../mcp/tools/interactivePromptLiveness';
import { openPrompt } from '../openPromptRegistry';
import { setSessionPendingPrompt } from '../pendingPromptPersistence';

let n = 0;
let sid = '';

beforeEach(() => {
  sid = `routing-${++n}`;
  h.rows.length = 0;
  h.provider = 'claude-code';
  h.providerInstance = undefined;
  h.states.clear();
  h.queued.clear();
  h.ipcMain.removeAllListeners();
  vi.clearAllMocks();
});

const respondToForm = (promptId: string) => {
  registerSessionPromptResponseHandler();
  return h.handlers.get('messages:respond-to-prompt')!({ sender: { send: vi.fn() } }, {
    sessionId: sid,
    promptId,
    promptType: 'request_user_input_request',
    response: { answers: { ok: { type: 'confirm', value: true } } },
    respondedBy: 'desktop',
  });
};

const answerQuestion = (sendMessageHandler: () => unknown, questionId: string) => {
  registerAskUserQuestionAnswerHandler({ sendMessageHandler } as any);
  return h.handlers.get('claude-code:answer-question')!({}, { questionId, answers: { Q: 'stale' }, sessionId: sid });
};

describe('an answer for a card with no live waiter', () => {
  it('closes its own form and leaves the live form and its turn alone', async () => {
    const liveForm = vi.fn();
    h.ipcMain.on(`request-user-input-response:${sid}:toolu_live`, vi.fn());
    h.ipcMain.on(`request-user-input-response:${sid}:__fallback__`, liveForm);
    noteLiveInteractivePrompt(sid);
    const resume = vi.fn(async () => undefined);
    configureAnswerResume({ send: resume, publish: vi.fn(async () => {}), drive: vi.fn(async () => undefined) });
    try {
      expect(await respondToForm('toolu_stale')).toMatchObject({ success: true });

      expect(liveForm).not.toHaveBeenCalled();
      expect(h.rows).toEqual([expect.objectContaining({ toolUseId: 'toolu_stale', result: expect.objectContaining({ cancelled: false }) })]);
      await new Promise((resolve) => setImmediate(resolve));
      expect(resume).not.toHaveBeenCalled();
      // The answer waits for the live prompt's turn to end.
      expect([...h.queued.values()]).toEqual([expect.objectContaining({ prompt: expect.stringContaining('PromptForUserInput') })]);
    } finally {
      clearLiveInteractivePrompt(sid);
    }
  });

  it('closes its own question and leaves the live question and its turn alone', async () => {
    const liveQuestion = vi.fn();
    h.ipcMain.on(`ask-user-question-response:${sid}:toolu_live`, vi.fn());
    h.ipcMain.on(`ask-user-question:${sid}`, liveQuestion);
    noteLiveInteractivePrompt(sid);
    const sendMessageHandler = vi.fn();
    configureAnswerResume({ send: sendMessageHandler, publish: vi.fn(async () => {}), drive: vi.fn(async () => undefined) });
    try {
      expect(await answerQuestion(sendMessageHandler, 'toolu_stale')).toEqual({ success: true });

      expect(liveQuestion).not.toHaveBeenCalled();
      expect(h.rows).toEqual([expect.objectContaining({ toolUseId: 'toolu_stale' })]);
      await new Promise((resolve) => setImmediate(resolve));
      expect(sendMessageHandler).not.toHaveBeenCalled();
      expect([...h.queued.values()]).toEqual([expect.objectContaining({ prompt: expect.stringContaining('Q: stale') })]);
    } finally {
      clearLiveInteractivePrompt(sid);
    }
  });

  it('still reaches a fallback waiter on a provider whose waiter ids do not match its cards', async () => {
    h.provider = 'opencode';
    const waiter = vi.fn();
    h.ipcMain.on(`request-user-input-response:${sid}:__fallback__`, waiter);

    expect(await respondToForm('toolu_card')).toMatchObject({ success: true });

    expect(waiter).toHaveBeenCalledWith(null, expect.objectContaining({ promptId: 'toolu_card' }));
    expect(h.rows).toEqual([]);
  });
});

// Round 2: Cancel had the same cross-card fallback. On a dead MCP card it either
// did nothing (another question's listener swallowed it, the reservation was
// spent, and the card could neither close nor be answered) or aborted whatever
// turn was running, background subagents included.
describe('Cancel on a card with no live waiter', () => {
  const cancel = (questionId: string) => {
    registerInteractivePromptHandlers({ sendMessageHandler: vi.fn(), driveQueuedPrompts: vi.fn(), publishQueueStateToSync: vi.fn() } as any);
    return h.handlers.get('claude-code:cancel-question')!({}, { questionId, sessionId: sid });
  };

  it.each([
    ['another question is live', true],
    ['nothing else is live', false],
  ])('closes its own card and never aborts the turn when %s', async (_label, otherLive) => {
    const provider = { rejectAskUserQuestion: vi.fn(), abort: vi.fn() };
    h.providerInstance = provider;
    const liveQuestion = vi.fn();
    if (otherLive) {
      h.ipcMain.on(`ask-user-question-response:${sid}:toolu_live`, vi.fn());
      h.ipcMain.on(`ask-user-question:${sid}`, liveQuestion);
      noteLiveInteractivePrompt(sid);
    }
    try {
      expect(await cancel('toolu_stale')).toMatchObject({ success: true });

      expect(liveQuestion).not.toHaveBeenCalled();
      expect(provider.abort).not.toHaveBeenCalled();
      expect(h.rows).toEqual([expect.objectContaining({ toolUseId: 'toolu_stale', result: expect.objectContaining({ cancelled: true }) })]);
      // The live question still owns the session's pending-prompt bit.
      expect(vi.mocked(setSessionPendingPrompt).mock.calls.some(([id, on]) => id === sid && on === false)).toBe(!otherLive);
    } finally {
      if (otherLive) clearLiveInteractivePrompt(sid);
    }
  });

  it('still rejects a question the provider holds and stops its turn', async () => {
    const provider = { rejectAskUserQuestion: vi.fn(), abort: vi.fn() };
    h.providerInstance = provider;
    openPrompt(sid, 'toolu_sdk', 'decision');

    expect(await cancel('toolu_sdk')).toEqual({ success: true });

    expect(provider.rejectAskUserQuestion).toHaveBeenCalledWith('toolu_sdk', expect.any(Error));
    expect(provider.abort).toHaveBeenCalledTimes(1);
    // The provider logs this card's cancelled result itself.
    expect(h.rows).toEqual([]);
  });
});

// Round 3: a released card (#1116) has no waiter, but its turn may still be
// running, background subagents included. sendMessage would replace that
// request and endSession would idle it mid-flight, so the answer waits in the
// prompt queue until the turn ends. An idle session is resumed at once.
describe('an answer on a released card reaches the agent without replacing its turn', () => {
  const event = { sender: { send: vi.fn() } };
  const ctx = () => ({
    sendMessageHandler: vi.fn(async () => ({ content: '' })),
    driveQueuedPrompts: vi.fn(async () => ({ kind: 'deferred', reason: 'session-busy' })),
    publishQueueStateToSync: vi.fn(async () => {}),
  });
  const answer = (c: ReturnType<typeof ctx>, kind: 'question' | 'form', id: string) => {
    registerInteractivePromptHandlers(c as any);
    registerSessionPromptResponseHandler();
    return kind === 'question'
      ? h.handlers.get('claude-code:answer-question')!(event, { questionId: id, answers: { Q: 'later' }, sessionId: sid })
      : h.handlers.get('messages:respond-to-prompt')!(event, {
          sessionId: sid, promptId: id, promptType: 'request_user_input_request',
          response: { answers: { Q: 'later' } }, respondedBy: 'desktop',
        });
  };
  const commit = (c: ReturnType<typeof ctx>, response: Record<string, unknown>) => {
    registerInteractivePromptHandlers(c as any);
    registerSessionPromptResponseHandler();
    return h.handlers.get('messages:respond-to-prompt')!(event, {
      sessionId: sid, promptId: 'toolu_commit', promptType: 'git_commit_proposal_request', response, respondedBy: 'desktop',
    });
  };
  const queuedPrompts = () => [...h.queued.values()];
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const committed = { action: 'committed', commitHash: 'abc1234', filesCommitted: ['a.ts'], commitMessage: 'fix: thing' };

  it.each(['question', 'form'] as const)('queues a %s answer given while the released turn still runs', async (kind) => {
    h.states.set(sid, { status: 'running' });
    const c = ctx();

    expect(await answer(c, kind, 'toolu_released')).toMatchObject({ success: true });
    await settle();

    expect(h.rows).toEqual([expect.objectContaining({ toolUseId: 'toolu_released' })]);
    expect(c.sendMessageHandler).not.toHaveBeenCalled();
    expect(queuedPrompts()).toEqual([expect.objectContaining({
      sessionId: sid,
      prompt: expect.stringContaining('later'),
      documentContext: { promptOrigin: 'interactive-question' },
    })]);
    await vi.waitFor(() => expect(c.driveQueuedPrompts).toHaveBeenCalledWith(sid, '/ws', 'session-idle'));
  });

  it('resumes an idle session with a question answer straight away', async () => {
    const c = ctx();

    expect(await answer(c, 'question', 'toolu_released')).toEqual({ success: true });

    await vi.waitFor(() => expect(c.sendMessageHandler).toHaveBeenCalledTimes(1));
    expect(c.sendMessageHandler).toHaveBeenCalledWith(event, '[Resuming after answering a question]\n\nQ: later', { promptOrigin: 'interactive-question' }, sid, '/ws');
    expect(queuedPrompts()).toEqual([]);
  });

  it('queues a second released answer behind the resume the first one started', async () => {
    const c = ctx();
    let finishTurn!: () => void;
    c.sendMessageHandler.mockImplementationOnce(() => new Promise((resolve) => { finishTurn = () => resolve({ content: '' }); }));

    await answer(c, 'question', 'toolu_first');
    await answer(c, 'form', 'toolu_second');
    await settle();

    // The first resume has not marked its turn running yet; a drive now would dispatch beside it.
    expect(c.sendMessageHandler).toHaveBeenCalledTimes(1);
    expect(queuedPrompts()).toHaveLength(1);
    expect(c.driveQueuedPrompts).not.toHaveBeenCalled();

    finishTurn();
    await vi.waitFor(() => expect(c.driveQueuedPrompts).toHaveBeenCalledWith(sid, '/ws', 'session-idle'));
    expect(c.sendMessageHandler).toHaveBeenCalledTimes(1);
  });

  it('queues the outcome of a commit confirmed while the released turn still runs, without idling it', async () => {
    h.states.set(sid, { status: 'running' });
    const c = ctx();

    expect(await commit(c, committed)).toMatchObject({ success: true });
    await settle();

    expect(h.endSession).not.toHaveBeenCalled();
    expect(c.sendMessageHandler).not.toHaveBeenCalled();
    expect(queuedPrompts()).toEqual([expect.objectContaining({
      prompt: expect.stringContaining('Commit hash: abc1234'),
      documentContext: { promptOrigin: 'interactive-question' },
    })]);
    await vi.waitFor(() => expect(c.driveQueuedPrompts).toHaveBeenCalledWith(sid, '/ws', 'session-idle'));
  });

  it.each([
    ['committed', committed, 'User confirmed and committed 1 file(s).\nCommit hash: abc1234'],
    ['failed', { action: 'error', error: 'index.lock exists' }, 'Commit failed: index.lock exists'],
  ])('tells an idle agent its released commit %s', async (_label, response, text) => {
    const c = ctx();

    expect(await commit(c, response)).toMatchObject({ success: true });

    await vi.waitFor(() => expect(c.sendMessageHandler).toHaveBeenCalledTimes(1));
    expect(c.sendMessageHandler).toHaveBeenCalledWith(event, expect.stringContaining(text), { promptOrigin: 'interactive-question' }, sid, '/ws');
    expect(queuedPrompts()).toEqual([]);
  });

  it('closes a released proposal cancelled mid-turn without idling the turn or resuming it', async () => {
    h.states.set(sid, { status: 'running' });
    const c = ctx();

    expect(await commit(c, { action: 'cancelled' })).toMatchObject({ success: true });
    await settle();

    expect(h.endSession).not.toHaveBeenCalled();
    expect(c.sendMessageHandler).not.toHaveBeenCalled();
    expect(queuedPrompts()).toEqual([]);
  });
});
