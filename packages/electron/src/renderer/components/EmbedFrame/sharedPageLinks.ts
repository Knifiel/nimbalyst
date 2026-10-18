/**
 * Resolves a relative link between pages in a Team or Personal page tree,
 * the way the web console does (`embedResolution.ts` there): against the
 * linking page's folder, where a markdown page titled `Module` answers to
 * `Module.md`. An exact path wins; otherwise a name that only one page has.
 */

import { getSharedDocumentDisplayPath, UNRESOLVED_SHARED_DOCUMENT_NAME } from '../CollabMode/collabTree';
import type { SharedDocument, SharedFolder } from '../../store/atoms/collabDocuments';

function joinPagePath(dir: string, link: string): string {
  const parts = link.startsWith('/') ? [] : dir.split('/').filter(Boolean);
  for (const segment of link.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/');
}

export function resolveSharedPageLink(
  href: string,
  fromDocumentId: string,
  documents: readonly SharedDocument[],
  folders: SharedFolder[],
): string | null {
  let link: string;
  try {
    link = decodeURIComponent(href.split(/[?#]/)[0]!);
  } catch {
    return null;
  }
  if (!link) return null;
  const pathOf = (document: SharedDocument) => {
    const path = getSharedDocumentDisplayPath(document, folders);
    return path && path !== UNRESOLVED_SHARED_DOCUMENT_NAME ? path.toLowerCase() : null;
  };
  const from = documents.find((document) => document.documentId === fromDocumentId);
  const fromPath = from ? pathOf(from) ?? '' : '';
  const target = joinPagePath(fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '', link).toLowerCase();
  if (!target) return null;

  const pathsOf = (document: SharedDocument) => {
    const path = pathOf(document);
    if (!path) return [];
    return document.documentType === 'markdown' && !/\.(md|markdown)$/.test(path) ? [path, `${path}.md`] : [path];
  };
  const candidates = documents.filter((document) =>
    document.documentId !== fromDocumentId && !document.trashedAt && !document.decryptFailed);
  const exact = candidates.filter((document) => pathsOf(document).includes(target));
  if (exact.length === 1) return exact[0]!.documentId;
  if (exact.length > 1) return null;
  const name = target.slice(target.lastIndexOf('/') + 1);
  const named = candidates.filter((document) => pathsOf(document).some((path) => path.slice(path.lastIndexOf('/') + 1) === name));
  return named.length === 1 ? named[0]!.documentId : null;
}
