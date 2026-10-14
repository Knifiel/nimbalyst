/**
 * Types for `vite.mjs`. Plugin hooks are typed structurally rather than from
 * `vite`, so each app checks them against its own Vite version.
 */
import type { PinnedExtension } from './pinnedExtensions.mjs';

export interface PinnedExtensionBundle extends PinnedExtension {
  cssPath: string;
  /** The Vite virtual module id, and this bundle's key in the build manifest. */
  entryId: string;
  entryPath: string;
  /** Where the pinned package is installed. The host manifest is read from here. */
  installedRoot: string;
  outputPath: string;
  publicUrl: string;
  version: string;
}

export declare const pinnedRuntimeBridgePath: string;
export declare const webEditorsSourceDir: string;
export declare const runtimeSourceDir: string;

export declare function findPinnedExtensionRoot(pin: PinnedExtension, resolveFrom: string): string | null;

export declare function resolvePinnedExtensionBundle(options: {
  command: 'serve' | 'build';
  installedRoot?: string;
  mode: string;
  pin: PinnedExtension;
  /** The app directory whose node_modules are searched first. */
  resolveFrom: string;
  /** Prefix for error messages, e.g. `web-console`. */
  label?: string;
}): PinnedExtensionBundle;

export declare function readPinnedExtensionHostManifest(installedRoot: string): Record<string, unknown>;

export declare function pinnedExtensionDefines(bundles: readonly PinnedExtensionBundle[]): Record<string, string>;

type ParseAst = (code: string) => unknown;

export declare function hasDefaultExport(entryPath: string, parseAst: ParseAst): boolean;

export interface PinnedExtensionBundleEntriesPlugin {
  name: string;
  resolveId(id: string): string | null;
  load(id: string): string | null;
  generateBundle(this: { emitFile(file: { type: 'asset'; fileName: string; source: string }): string }): void;
}

export declare function pinnedExtensionBundleEntries(
  bundles: readonly PinnedExtensionBundle[],
  options: { parseAst: ParseAst; provenance?: unknown },
): PinnedExtensionBundleEntriesPlugin;

export declare function pinnedExtensionBuildInputs(bundles: readonly PinnedExtensionBundle[]): Record<string, string>;
export declare function pinnedExtensionEntryFileNames(
  bundles: readonly PinnedExtensionBundle[],
  fallback?: string,
): (chunkInfo: { name: string }) => string;
