/**
 * Types for `@nimbalyst/runtime/core/pageMarkSyntax`, the app's decision and
 * open-question mark parser (packages/runtime/src/core/pageMarkSyntax.ts).
 *
 * That file is pure, but it lives outside this package's rootDir, so
 * tsconfig.json `paths` points tsc here while the bundlers (scripts/build.mjs,
 * vitest.config.ts and the plugin's scripts/build-wiki-plugin.mjs) alias the
 * specifier to the source. The CLI then parses marks with the app's own code.
 * Keep these a subset of that file's exports.
 */
export type PageMarkKind = 'decided' | 'open';

export interface PageMarkOccurrence {
  kind: PageMarkKind;
  by?: string;
  email?: string;
  on?: string;
  over?: string;
  /** Inline markdown of the marked sentence, exactly as written. */
  text: string;
  /** The sentence with links, emphasis and citations reduced to text. */
  plainText: string;
  rawAttrs: string;
  start: number;
  end: number;
  /** 1-based line of the mark's opening bracket. */
  line: number;
}

/** Every mark in a markdown body, in document order; code and frontmatter are skipped. */
export declare function findPageMarks(markdown: string): PageMarkOccurrence[];
