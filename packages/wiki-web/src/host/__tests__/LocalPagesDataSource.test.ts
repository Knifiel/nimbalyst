// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { toLocalCommand } from '../LocalPagesDataSource';

describe('toLocalCommand', () => {
  it('stores an editor page rename as the stem, and creates an editor page with its suffix and starting text', () => {
    const extension = (id: string) => (id === 'draw' ? '.excalidraw' : undefined);
    expect(toLocalCommand({ type: 'update-document-title', documentId: 'draw', title: 'Flow v2.excalidraw' }, extension))
      .toEqual({ type: 'update-document-title', documentId: 'draw', title: 'Flow v2' });
    expect(toLocalCommand({ type: 'update-document-title', documentId: 'page', title: 'Notes.excalidraw' }, extension))
      .toEqual({ type: 'update-document-title', documentId: 'page', title: 'Notes.excalidraw' });
    const metadata = { metadataVersion: 2 as const, fileExtension: '.mindmap', editorId: 'com.nimbalyst.mindmap' };
    expect(toLocalCommand({ type: 'register-document', documentId: 'x', title: 'Map', documentType: 'mindmap', parentFolderId: null, metadata }, extension, () => '# Map\n'))
      .toEqual({ type: 'register-document', documentId: 'x', title: 'Map', parentFolderId: null, sortOrder: null, documentType: 'mindmap', fileExtension: '.mindmap', body: '# Map\n' });
    expect(() => toLocalCommand({ type: 'register-document', documentId: 'y', title: 'Map', documentType: 'mindmap', parentFolderId: null }))
      .toThrow(/file extension/);
  });
});
