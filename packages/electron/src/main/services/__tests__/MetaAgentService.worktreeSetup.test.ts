// @vitest-environment node
/**
 * An agent's spawn into a NEW worktree gets the worktree the project is set up
 * for (the provisioner adds the user's repositories and the setup step), and
 * the child's first prompt waits for the setup command -- an install the child
 * would otherwise build against half-done, or race with a second install.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: { create: vi.fn(), updateMetadata: vi.fn(), get: vi.fn() },
}));
vi.mock('@nimbalyst/runtime/storage/repositories/AgentMessagesRepository', () => ({
  AgentMessagesRepository: { create: vi.fn() },
}));
vi.mock('@nimbalyst/runtime/storage/repositories/SessionFilesRepository', () => ({ SessionFilesRepository: {} }));
vi.mock('@nimbalyst/runtime/ai/server', () => ({
  ClaudeCodeProvider: { setMetaAgentServerPort: vi.fn() },
  OpenAICodexProvider: { setMetaAgentServerPort: vi.fn() },
  OpenAICodexACPProvider: { setMetaAgentServerPort: vi.fn() },
  SessionManager: class { async initialize() {} },
}));
vi.mock('@nimbalyst/runtime/ai/server/types', () => ({
  ModelIdentifier: {
    parse: (id: string) => {
      const i = id.indexOf(':');
      return { provider: id.slice(0, i), model: id.slice(i + 1), combined: id };
    },
    tryParse: (id: string) => {
      const i = typeof id === 'string' ? id.indexOf(':') : -1;
      return i > 0 ? { provider: id.slice(0, i), model: id.slice(i + 1) } : null;
    },
    getDefaultModelId: (provider: string) => `${provider}:default`,
  },
}));
vi.mock('@nimbalyst/runtime/ai/server/SessionStateManager', () => ({ getSessionStateManager: () => ({ subscribe: vi.fn() }) }));
vi.mock('../ai/providerResolution', () => ({ resolveExtensionAgentRef: () => null, isExtensionAgentProvider: () => false }));
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../SyncManager', () => ({ getSyncProvider: () => ({ pushChange: vi.fn() }) }));
vi.mock('../../utils/ipcRegistry', () => ({ safeHandle: vi.fn() }));
vi.mock('../../utils/store', () => ({
  getDefaultAIModel: () => null,
  getAgentPermissions: () => ({}),
  getAttachedFolders: () => [],
  getRecentItems: () => [],
  setWorkspaceTrusted: vi.fn(),
}));
vi.mock('../../utils/timestampUtils', () => ({ toMillis: (v: unknown) => v }));
vi.mock('../WorktreeStore', () => ({
  createWorktreeStore: () => ({ get: async () => null, getAllNames: async () => [] }),
}));
vi.mock('../GitWorktreeService', () => ({
  GitWorktreeService: class {
    getExistingWorktreeDirectories() { return []; }
    async getAllBranchNames() { return []; }
    generateUniqueWorktreeName() { return 'swift-falcon'; }
  },
}));
vi.mock('../../database/PGLiteDatabaseWorker', () => ({
  database: { query: vi.fn().mockResolvedValue({ rows: [{ in_flight: '0', total: '0' }] }) },
}));
vi.mock('../../database/initialize', () => ({ getDatabase: () => ({ kind: 'fake-db' }) }));
vi.mock('./ai/AIService', () => ({ AIService: class {} }));
vi.mock('../../mcp/metaAgentServer', () => ({ setMetaAgentToolFns: vi.fn() }));
vi.mock('../metaAgentNotificationSignature', () => ({ computeNotificationSignature: vi.fn() }));
vi.mock('../metaAgentMessageText', () => ({ extractMessageText: vi.fn(), extractUserPrompts: vi.fn() }));
vi.mock('../ai/claudeCliLauncherSingleton', () => ({ ClaudeCliLauncherConfig: { setMetaAgentServerPort: vi.fn() } }));

import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { MetaAgentService } from '../MetaAgentService';

const PROMPT = 'implement step 2 of the plan';

describe('spawning a session into a new worktree', () => {
  let workspace: string;
  let service: any;
  let aiService: { queuePromptForSession: ReturnType<typeof vi.fn>; triggerQueuedPromptProcessingForSession: ReturnType<typeof vi.fn> };
  let provisioner: { create: ReturnType<typeof vi.fn>; waitForSetup: ReturnType<typeof vi.fn> };
  let finishSetup: (outcome: string) => void;

  beforeEach(() => {
    workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nim-agent-wt-')));
    vi.mocked(AISessionsRepository.create).mockReset();
    vi.mocked(AISessionsRepository.get).mockReset().mockImplementation(async (id: string) =>
      id === 'meta'
        ? { id: 'meta', provider: 'claude-code', model: 'claude-code:opus', agentRole: 'standard', sessionType: 'session', parentSessionId: null, worktreeId: null, workspacePath: workspace } as any
        : null);
    aiService = { queuePromptForSession: vi.fn(), triggerQueuedPromptProcessingForSession: vi.fn() };
    provisioner = {
      create: vi.fn().mockResolvedValue({ worktree: { id: 'wt-1', path: `${workspace}_worktrees/swift-falcon` }, setupTerminalId: 'term-1' }),
      waitForSetup: vi.fn(() => new Promise<string>(resolve => { finishSetup = resolve; })),
    };
    service = MetaAgentService.getInstance();
    service.aiService = aiService;
    service.setWorktreeProvisioner(provisioner);
    // vitest runs with NODE_ENV=test, which makes the service skip real prompt queueing
    vi.spyOn(service, 'shouldBypassChildAgentExecutionForTests').mockReturnValue(false);
  });

  afterEach(() => fs.rmSync(workspace, { recursive: true, force: true }));

  it('passes the agent\'s repositories on and holds the first prompt until the setup command finishes', async () => {
    const result = await service.createChildSessionInternal('meta', workspace, { prompt: PROMPT, useWorktree: true, repos: ['api'] });

    expect(provisioner.create).toHaveBeenCalledWith({
      workspacePath: workspace, name: 'swift-falcon', repos: ['api'], refWatcherWorkspace: workspace,
    });
    expect(result).toMatchObject({ worktreeId: 'wt-1', worktreeMode: 'new', waitingForWorktreeSetup: true });
    expect(provisioner.waitForSetup).toHaveBeenCalledWith('term-1');
    expect(aiService.queuePromptForSession).not.toHaveBeenCalled();
    expect(aiService.triggerQueuedPromptProcessingForSession).not.toHaveBeenCalled();

    finishSetup('finished');
    await vi.waitFor(() => expect(aiService.triggerQueuedPromptProcessingForSession)
      .toHaveBeenCalledWith(result.sessionId, `${workspace}_worktrees/swift-falcon`, 'meta-agent'));
    expect(aiService.queuePromptForSession).toHaveBeenCalledTimes(1);
    expect(aiService.queuePromptForSession.mock.calls[0].slice(0, 2)).toEqual([result.sessionId, PROMPT]);
  });

  it('starts the child right away when the project has no setup command', async () => {
    provisioner.create.mockResolvedValue({ worktree: { id: 'wt-2', path: `${workspace}_worktrees/swift-falcon` } });

    const result = await service.createChildSessionInternal('meta', workspace, { prompt: PROMPT, useWorktree: true });

    expect(provisioner.create.mock.calls[0][0].repos).toBeUndefined();
    expect(result.waitingForWorktreeSetup).toBe(false);
    expect(provisioner.waitForSetup).not.toHaveBeenCalled();
    expect(aiService.queuePromptForSession).toHaveBeenCalledTimes(1);
    expect(aiService.triggerQueuedPromptProcessingForSession).toHaveBeenCalledTimes(1);
  });

  it('refuses repositories without a new worktree', async () => {
    await expect(service.createChildSessionInternal('meta', workspace, { prompt: PROMPT, repos: ['api'] }))
      .rejects.toThrow('repos only applies with useWorktree=true');
    expect(provisioner.create).not.toHaveBeenCalled();
  });
});
