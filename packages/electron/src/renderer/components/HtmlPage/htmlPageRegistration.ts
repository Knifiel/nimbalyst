/**
 * The `html` page type's editor registration, and the lookup page hosts use
 * so that a shared or personal `.html` page opens in it.
 *
 * It is deliberately not in `customEditorRegistry`: the Browser extension
 * owns `.html` for workspace files opened in a tab, and that stays as it is.
 * Only a page whose document type is `html` gets this editor.
 */

import { lazy, Suspense, createElement } from 'react';
import type { EditorHostProps } from '@nimbalyst/runtime';
import { HTML_PAGE_DOCUMENT_TYPE } from '@nimbalyst/runtime/ui/htmlEmbed/htmlPageCodec';

import type { CustomEditorRegistration } from '../CustomEditors/types';
import { customEditorRegistry } from '../CustomEditors';
import { HTML_PAGE_EDITOR_COMPONENT, HTML_PAGE_EDITOR_ID } from './htmlPageEditorId';

export { HTML_PAGE_EDITOR_COMPONENT, HTML_PAGE_EDITOR_ID };

const LazyHtmlPageEditor = lazy(async () => ({ default: (await import('./HtmlPageEditor')).HtmlPageEditor }));

function HtmlPageEditorLoader(props: EditorHostProps) {
  return createElement(
    Suspense,
    { fallback: createElement('div', { className: 'html-page-editor html-page-editor--pending' }) },
    createElement(LazyHtmlPageEditor, props),
  );
}

export const HTML_PAGE_EDITOR_REGISTRATION: CustomEditorRegistration = {
  extensions: ['.html'],
  component: HtmlPageEditorLoader,
  name: 'HTML page',
  extensionId: HTML_PAGE_EDITOR_ID,
  componentName: HTML_PAGE_EDITOR_COMPONENT,
  supportsSourceMode: false,
  showDocumentHeader: false,
  collaboration: { supported: true, awarenessFields: [] },
};

/**
 * The editor for a page: the HTML page editor for an `html` page (or one
 * recorded as edited by it), otherwise whatever claims the file name.
 */
export function findPageEditorRegistration(
  lookupName: string,
  page: { documentType?: string | null; editorId?: string | null },
): CustomEditorRegistration | undefined {
  if (page.documentType === HTML_PAGE_DOCUMENT_TYPE || page.editorId === HTML_PAGE_EDITOR_ID) {
    return HTML_PAGE_EDITOR_REGISTRATION;
  }
  return customEditorRegistry.findRegistrationForFile(lookupName);
}
