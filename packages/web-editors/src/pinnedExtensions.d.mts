/**
 * Types for `pinnedExtensions.mjs`, which is plain Node so build scripts can
 * import it.
 */

export interface PinnedExtension {
  /** The npm package name an app depends on. */
  package: string;
  /** The short name every derived identifier and emitted path is built from. */
  slug: string;
  /** A sibling checkout of stravu-editor that holds the package, when it has its own repo. */
  checkout?: string;
}

export declare const PINNED_EXTENSIONS: readonly PinnedExtension[];
export declare const PINNED_EXTENSION_VERSION_PATTERN: RegExp;

export declare function pinnedExtensionEntryId(slug: string): string;
export declare function pinnedExtensionDevUrl(slug: string): string;
export declare function pinnedExtensionOutputPath(slug: string, version: string): string;
export declare function pinnedExtensionEnvPrefix(slug: string): string;
export declare function pinnedExtensionUrlDefine(slug: string): string;
export declare function pinnedExtensionManifestDefine(slug: string): string;
