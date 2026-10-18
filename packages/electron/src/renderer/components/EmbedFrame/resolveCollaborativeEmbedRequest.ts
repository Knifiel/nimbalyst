/**
 * Turn a shared-document reference into everything needed to mount its
 * collaborative editor.
 *
 * Extracted from `EmbedFrame` when the feedback option-card preview needed the
 * same answer. The steps look mechanical but each one refuses for its own
 * reason, and a second copy would inevitably refuse for fewer of them: the type
 * catalog has to resolve the document's metadata, the descriptor has to be an
 * extension editor, and the installed editor has to actually declare
 * collaboration support. Skipping the last check in particular yields an editor
 * that mounts and then quietly fails to sync.
 *
 * Pure: no atoms, no React. Callers read the shared-document row and the active
 * workspace themselves and pass values in.
 */

import type { CollaborativeEmbedProviderRequest } from '../../services/CollaborativeEmbedProviderCache';
import { findPageEditorRegistration } from '../HtmlPage/htmlPageRegistration';
import type { CustomEditorRegistration } from '../CustomEditors/types';
import { getCollaborativeDocumentTypeCatalog } from '../../services/CollaborativeDocumentTypeCatalog';

export interface CollaborativeEmbedResolutionInput {
  orgId: string;
  documentId: string;
  workspacePath: string;
  /** From the shared-document index; absent when the index has not caught up. */
  sharedTitle?: string | null;
  sharedDocumentType?: string | null;
  sharedFileExtension?: string | null;
  sharedEditorId?: string | null;
  /** Author-supplied extension hint, used only when the index has no type. */
  hintedExtension?: string | null;
  /** Fallback display name when the index has no title. */
  fallbackTitle?: string | null;
  /**
   * Accept documents whose editor is the app's own Lexical markdown editor
   * rather than an extension's.
   *
   * Opt-in, and deliberately so. A markdown embed needs a host that mounts
   * Lexical with a `CollabLexicalProvider` -- which the canvas card does and
   * the in-document `EmbedFrame` does not, since it is *already* inside a
   * Lexical editor and nesting one in itself is a different problem. Callers
   * that leave this unset keep refusing markdown exactly as before.
   */
  allowLexical?: boolean;
}

/**
 * Who renders the document once its room is open.
 *
 * A union rather than an optional `registration`, because "no registration"
 * and "the built-in markdown editor" are different answers and a caller that
 * forgot to tell them apart would mount nothing and say nothing.
 */
export type CollaborativeEmbedEditorChoice =
  | { kind: 'extension'; registration: CustomEditorRegistration }
  | { kind: 'lexical' };

export type CollaborativeEmbedResolution =
  | {
      status: 'ready';
      request: CollaborativeEmbedProviderRequest;
      editor: CollaborativeEmbedEditorChoice;
      displayName: string;
    }
  | { status: 'unavailable'; error: string };

export function resolveCollaborativeEmbedRequest(
  input: CollaborativeEmbedResolutionInput,
): CollaborativeEmbedResolution {
  const catalog = getCollaborativeDocumentTypeCatalog();
  const hintedExtension = input.hintedExtension?.trim().toLowerCase();
  const metadataResolution = input.sharedDocumentType
    ? catalog.resolveMetadata(
        input.sharedDocumentType,
        input.sharedFileExtension ?? undefined,
        input.sharedEditorId ?? undefined,
      )
    : hintedExtension
      ? catalog.resolveShareability(`embedded${hintedExtension}`)
      : null;
  if (!metadataResolution || metadataResolution.state !== 'ready') {
    return { status: 'unavailable', error: 'The collaborative editor for this document is unavailable.' };
  }

  const descriptor = metadataResolution.descriptor;
  const isLexical = descriptor.editor.kind === 'lexical';
  if (descriptor.editor.kind !== 'extension' && !(isLexical && input.allowLexical === true)) {
    return { status: 'unavailable', error: 'Only collaborative custom-editor documents can be embedded.' };
  }

  const fileExtension = input.sharedFileExtension
    ?? hintedExtension
    ?? descriptor.defaultExtension;
  const editorId = input.sharedEditorId ?? catalog.editorIdForDescriptor(descriptor);

  // The Lexical branch has no registration to look up and no manifest to ask:
  // markdown collaboration is the app's own, and `CollaborativeTabEditor` has
  // been running it as the primary shared-document path all along.
  let editor: CollaborativeEmbedEditorChoice;
  if (isLexical) {
    editor = { kind: 'lexical' };
  } else {
    const registration = findPageEditorRegistration(`embedded${fileExtension}`, { documentType: input.sharedDocumentType ?? descriptor.documentType, editorId });
    if (!registration || registration.collaboration?.supported !== true) {
      return { status: 'unavailable', error: 'The installed editor does not support collaborative embeds.' };
    }
    editor = { kind: 'extension', registration };
  }

  const displayName = input.sharedTitle || input.fallbackTitle || input.documentId;
  return {
    status: 'ready',
    editor,
    displayName,
    request: {
      workspacePath: input.workspacePath,
      orgId: input.orgId,
      documentId: input.documentId,
      title: displayName,
      documentType: input.sharedDocumentType ?? descriptor.documentType,
      metadata: {
        metadataVersion: 2,
        fileExtension,
        editorId,
      },
    },
  };
}
