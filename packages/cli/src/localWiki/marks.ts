/**
 * Decision and open-question marks across the local wiki, read with the app's
 * own parser (`findPageMarks`, see types/pageMarkSyntax.d.ts for how the CLI
 * gets it), so "what did we decide about X" is one call.
 */
import { findPageMarks, type PageMarkKind } from '@nimbalyst/runtime/core/pageMarkSyntax';
import type { LocalPage, LocalWiki } from '@nimbalyst/local-wiki';

export const MARKS_DEFAULT_LIMIT = 50;

export interface ListedMark {
  pageId: string;
  title: string;
  line: number;
  kind: PageMarkKind;
  by?: string;
  email?: string;
  on?: string;
  over?: string;
  /** The marked sentence as plain text. */
  text: string;
}

export interface ListMarksOptions {
  kind?: PageMarkKind;
  /** Part of the name or email of who decided or owns the question, any case. */
  by?: string;
  /** Words that must all appear in the sentence, what it was chosen over, or the page title. */
  query?: string;
  limit?: number;
}

const byTitle = (a: LocalPage, b: LocalPage) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id);

export async function listMarks(opened: { wiki: LocalWiki }, options: ListMarksOptions = {}): Promise<{ total: number; marks: ListedMark[] }> {
  const limit = Math.max(1, Math.floor(options.limit ?? MARKS_DEFAULT_LIMIT));
  const by = options.by?.trim().toLowerCase();
  const words = (options.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const { pages } = await opened.wiki.snapshot();
  const marks: ListedMark[] = [];
  for (const page of pages.filter((p) => p.trashedAt === null && !p.malformed && p.documentType === 'markdown' && p.hasContent).sort(byTitle)) {
    const { markdown } = await opened.wiki.readBody(page.id);
    for (const mark of findPageMarks(markdown)) {
      if (options.kind && mark.kind !== options.kind) continue;
      if (by && !`${mark.by ?? ''}\n${mark.email ?? ''}`.toLowerCase().includes(by)) continue;
      if (words.length > 0) {
        const haystack = `${mark.plainText}\n${mark.over ?? ''}\n${page.title}`.toLowerCase();
        if (!words.every((word) => haystack.includes(word))) continue;
      }
      marks.push({
        pageId: page.id,
        title: page.title,
        line: mark.line,
        kind: mark.kind,
        ...(mark.by ? { by: mark.by } : {}),
        ...(mark.email ? { email: mark.email } : {}),
        ...(mark.on ? { on: mark.on } : {}),
        ...(mark.over ? { over: mark.over } : {}),
        text: mark.plainText,
      });
    }
  }
  return { total: marks.length, marks: marks.slice(0, limit) };
}
