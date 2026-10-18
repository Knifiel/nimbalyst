/**
 * The custom editor a file tab opens with.
 *
 * A Local wiki page is a file, but its `.html` pages are `html` pages: they
 * open in the HTML page editor, whose sandboxed preview routes links to other
 * wiki pages, as a Team or Personal HTML page does. Every other `.html` file
 * keeps the editor its extension registers (the Browser extension).
 */

import { HTML_PAGE_DOCUMENT_TYPE, isHtmlPagePath } from '@nimbalyst/runtime/ui/htmlEmbed/htmlPageCodec';

import type { CustomEditorRegistration } from '../CustomEditors/types';
import { customEditorRegistry } from '../CustomEditors';
import { findPageEditorRegistration } from '../HtmlPage/htmlPageRegistration';
import { getPersonalCollabHost } from '../../store/atoms/collabDocuments';

function isLocalWikiHtmlPage(filePath: string, workspacePath: string | undefined): boolean {
  if (!workspacePath || !isHtmlPagePath(filePath)) return false;
  return getPersonalCollabHost(workspacePath).source().documentIdForFile(filePath) !== null;
}

export function findTabEditorRegistration(
  filePath: string,
  workspacePath: string | undefined,
): CustomEditorRegistration | undefined {
  if (isLocalWikiHtmlPage(filePath, workspacePath)) {
    return findPageEditorRegistration(filePath, { documentType: HTML_PAGE_DOCUMENT_TYPE });
  }
  return customEditorRegistry.findRegistrationForFile(filePath);
}
