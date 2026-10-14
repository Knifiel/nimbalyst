// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import type { CollabScope } from '@nimbalyst/collab-client/core';
import { asTeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';
import { createCollabDocsSession } from '@nimbalyst/collab-client/docs';
import {
  activeCollabScopeAtom,
  getElectronCollabHostForScopeKey,
  getPersonalCollabDocsSession,
  initSharedDocuments,
  invalidateElectronCollabScopes,
  invalidateElectronCollabScopeWithoutTeam,
  personalPagesDocumentsAtomFamily,
  pruneCollabDocumentsScopeState,
  teamPagesStartErrorAtomFamily,
} from '../collabDocuments';

const WORKSPACE = '/workspace/personal-atoms';
const page = {
  documentId: 'p1', teamProjectId: null, title: 'Reading list.md', documentType: 'markdown',
  parentFolderId: null, createdBy: '', createdAt: 1, updatedAt: 1,
};

let invoke: ReturnType<typeof vi.fn>;

beforeEach(() => {
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'local-wiki:snapshot') return { items: [page], containers: [], pages: [] };
    if (channel === 'local-wiki:legacy-snapshot') return { items: [] };
    if (channel === 'workspace:get-state') return {};
    return { ok: true };
  });
  (globalThis as any).window = { electronAPI: { invoke, on: vi.fn(() => () => undefined) } };
});

afterEach(() => {
  pruneCollabDocumentsScopeState(WORKSPACE);
  delete (globalThis as any).window;
});

describe('Personal pages state', () => {
  it('exposes the personal documents by workspace and survives a sign-in or sign-out', async () => {
    await getPersonalCollabDocsSession(WORKSPACE).start();

    const documents = personalPagesDocumentsAtomFamily(WORKSPACE);
    expect(store.get(documents).map((document) => document.documentId)).toEqual(['p1']);
    expect(store.get(activeCollabScopeAtom)).toBeNull();

    // Auth and org changes re-resolve the team host only.
    const teamScopeChanges = vi.fn();
    getElectronCollabHostForScopeKey(WORKSPACE).onScopeChanged(teamScopeChanges);
    invoke.mockClear();
    invalidateElectronCollabScopes();

    expect(teamScopeChanges).toHaveBeenCalledWith(null);
    expect(invoke).not.toHaveBeenCalledWith('local-wiki:snapshot', WORKSPACE);
    expect(store.get(documents).map((document) => document.documentId)).toEqual(['p1']);
    expect(store.get(getPersonalCollabDocsSession(WORKSPACE).atoms.syncStatus)).toBe('connected');
  });
});

describe('Team pages failures', () => {
  const scope: CollabScope = {
    scopeKey: WORKSPACE,
    orgId: 'org-1',
    indexConfig: { serverUrl: 'ws://sync.test', teamProjectId: 'project-a', teamMemberId: asTeamMemberId('member-1') },
  };
  const teamSession = (snapshot: () => Promise<any>) => createCollabDocsSession(scope, {
    snapshot: vi.fn(snapshot),
    subscribe: () => () => undefined,
    command: vi.fn(),
    status: () => 'disconnected',
    dispose: vi.fn(),
  } as any, {
    personalState: { status: 'unavailable' },
    documents: {
      readReceipts: { status: 'unavailable' },
      loadViewPreferences: async () => null,
    },
  } as any);

  it('keeps why team pages failed to start for Pages to show, and clears it when a retry starts them', async () => {
    let fail = true;
    const session = teamSession(async () => {
      if (fail) throw new Error('Team room refused the connection (403)');
      return { items: [], containers: [] };
    });

    await initSharedDocuments(scope);
    expect(store.get(teamPagesStartErrorAtomFamily(WORKSPACE))).toBe('Team room refused the connection (403)');
    expect(store.get(session.atoms.syncStatus)).toBe('error');

    fail = false;
    await initSharedDocuments(scope);
    expect(store.get(teamPagesStartErrorAtomFamily(WORKSPACE))).toBeNull();
  });

  it('re-resolves a workspace without a team session, and leaves a running one alone', () => {
    const scopeChanges = vi.fn();
    getElectronCollabHostForScopeKey(WORKSPACE).onScopeChanged(scopeChanges);

    invalidateElectronCollabScopeWithoutTeam(WORKSPACE);
    expect(scopeChanges).toHaveBeenCalledWith(null);

    scopeChanges.mockClear();
    teamSession(async () => ({ items: [], containers: [] }));
    invalidateElectronCollabScopeWithoutTeam(WORKSPACE);
    expect(scopeChanges).not.toHaveBeenCalled();
  });
});
