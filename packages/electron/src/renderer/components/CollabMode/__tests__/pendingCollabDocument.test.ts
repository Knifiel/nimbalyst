// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { pendingCollabDocumentFailure, resolvePendingCollabDocument } from '../pendingCollabDocument';
import type { PendingCollabDocument, SharedDocument } from '../../../store/atoms/collabDocuments';

const drawing: SharedDocument = {
  documentId: 'doc-drawing',
  teamProjectId: 'project-b',
  title: 'Architecture',
  documentType: 'excalidraw',
  createdBy: 'member-a',
  createdAt: 1,
  updatedAt: 2,
};

const deepLink: PendingCollabDocument = {
  scopeKey: '/workspace/a',
  orgId: 'org-1',
  documentId: 'doc-drawing',
  analyticsSource: 'deep_link',
};

describe('resolvePendingCollabDocument', () => {
  it('holds a deep link to a page the index has not delivered yet instead of opening a markdown placeholder', () => {
    expect(resolvePendingCollabDocument(deepLink, {
      linkableDocuments: [],
      indexLoaded: false,
      indexUnavailable: null,
      teamProjectId: 'project-a',
      now: 10,
    })).toEqual({ action: 'wait' });
  });

  it('opens the indexed entry with its stored type once the index has it, including another project\'s page', () => {
    expect(resolvePendingCollabDocument(deepLink, {
      linkableDocuments: [drawing],
      indexLoaded: true,
      indexUnavailable: null,
      teamProjectId: 'project-a',
      now: 10,
    })).toEqual({ action: 'open', document: drawing });
  });

  it('reports a page absent from a loaded index as not found', () => {
    expect(resolvePendingCollabDocument(deepLink, {
      linkableDocuments: [],
      indexLoaded: true,
      indexUnavailable: null,
      teamProjectId: 'project-a',
      now: 10,
    })).toEqual({ action: 'not-found' });
  });

  it('fails a waiting link once the index cannot be reached, but still opens a page it already holds', () => {
    expect(resolvePendingCollabDocument(deepLink, {
      linkableDocuments: [],
      indexLoaded: false,
      indexUnavailable: "Your team's page index could not be reached.",
      teamProjectId: 'project-a',
      now: 10,
    })).toEqual({ action: 'failed', message: "Your team's page index could not be reached." });
    expect(resolvePendingCollabDocument(deepLink, {
      linkableDocuments: [drawing],
      indexLoaded: false,
      indexUnavailable: "Your team's page index could not be reached.",
      teamProjectId: 'project-a',
      now: 10,
    })).toEqual({ action: 'open', document: drawing });
  });

  it('still opens a first share immediately with the type and content its creator supplied', () => {
    const firstShare: PendingCollabDocument = {
      ...deepLink,
      documentId: 'doc-new',
      documentType: 'mockup',
      initialContent: '<html></html>',
    };
    const result = resolvePendingCollabDocument(firstShare, {
      linkableDocuments: [],
      indexLoaded: false,
      indexUnavailable: null,
      teamProjectId: 'project-a',
      now: 10,
    });
    expect(result).toMatchObject({
      action: 'open',
      document: { documentId: 'doc-new', documentType: 'mockup', teamProjectId: 'project-a' },
    });
  });
});

describe('pendingCollabDocumentFailure', () => {
  const team = { orgId: 'org-1' };

  it('keeps waiting while the team scope is still resolving or the index is loading', () => {
    expect(pendingCollabDocumentFailure(deepLink, { teamScope: null, teamUnavailable: null, startError: null })).toBeNull();
    expect(pendingCollabDocumentFailure(deepLink, { teamScope: team, teamUnavailable: null, startError: null })).toBeNull();
  });

  it('fails a link once the team lookup gave up or settled on no team', () => {
    expect(pendingCollabDocumentFailure(deepLink, {
      teamScope: null,
      teamUnavailable: { message: 'Team directory request timed out', retryable: true },
      startError: null,
    })).toBe("Your team's pages could not be reached: Team directory request timed out");
    expect(pendingCollabDocumentFailure(deepLink, {
      teamScope: null,
      teamUnavailable: { message: 'Not authenticated. Sign in first.', retryable: false },
      startError: null,
    })).toBe('Not authenticated. Sign in first.');
  });

  it('fails a link when team pages could not start, or the link is for another organization', () => {
    expect(pendingCollabDocumentFailure(deepLink, { teamScope: team, teamUnavailable: null, startError: 'socket closed' }))
      .toBe("Your team's pages could not be loaded: socket closed");
    expect(pendingCollabDocumentFailure(deepLink, { teamScope: { orgId: 'org-2' }, teamUnavailable: null, startError: null }))
      .toMatch(/different organization/);
  });
});
