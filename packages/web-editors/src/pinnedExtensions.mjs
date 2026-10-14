/**
 * Every extension a browser app can pin at build time, and the names derived
 * from each one.
 *
 * Shared by the web console (nimbalyst-collab) and the local wiki's browser
 * view (`@nimbalyst/wiki-web`), so the two cannot disagree about a slug, an
 * emitted path or a `define` identifier. An app chooses which rows it builds;
 * a row it does not build still gets its `define`s, as `null`, so the shared
 * loader in `pinnedExtensionBundles.ts` compiles in every app.
 *
 * Everything a pin needs is derived from its slug, so a new extension is a row
 * here, a dependency in the app that builds it, and its two `define`
 * identifiers in `pinnedExtensionBundles.ts` and `globals.d.ts`.
 *
 * This file is `.mjs` because build scripts are plain Node and cannot import
 * TypeScript. `pinnedExtensions.d.mts` beside it types it for `tsc`.
 */

/**
 * The pinned extensions, in build order.
 *
 * `package` is the npm name an app depends on; `slug` is the short name every
 * derived identifier and emitted path is built from. Keep the slug stable: it
 * appears in the deployed URL of the bundle.
 *
 * `checkout` names a sibling git checkout of the stravu-editor repo that holds
 * the package, for extensions that live in their own repo and are not
 * installed from npm. An app that does not depend on the package directly
 * finds it there (or under `NIMBALYST_EXTENSION_CHECKOUTS`); see
 * `resolvePinnedExtensionBundle` in `vite.mjs`.
 */
export const PINNED_EXTENSIONS = [
  { package: '@nimbalyst/extension-csv-spreadsheet', slug: 'csv-spreadsheet' },
  { package: '@nimbalyst/mockuplm', slug: 'mockuplm' },
  { package: '@nimbalyst/excalidraw-extension', slug: 'excalidraw' },
  { package: '@nimbalyst/extension-datamodellm', slug: 'datamodellm' },
  { package: 'com-nimbalyst-mindmap', slug: 'mindmap', checkout: 'nimbalyst-mindmap' },
  { package: '@nimbalyst/namenym', slug: 'namenym', checkout: 'nimbalyst-namenym' },
  { package: '@nimbalyst/extension-calc-sheets', slug: 'calc-sheets' },
];

/**
 * Versions reach a deployed URL, so they are restricted to what is safe in a
 * path segment rather than to a semver shape — a pinned extension is free to
 * carry a prerelease or build suffix.
 */
export const PINNED_EXTENSION_VERSION_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** `csv-spreadsheet` -> `CSV_SPREADSHEET`, for identifier and env-var names. */
function screamingSlug(slug) {
  return slug.replaceAll('-', '_').toUpperCase();
}

/** The Vite virtual module id, and the key it takes in the build manifest. */
export function pinnedExtensionEntryId(slug) {
  return `virtual:web-console-pinned-${slug}`;
}

/** The specifier the lazy loader imports while `vite dev` is serving. */
export function pinnedExtensionDevUrl(slug) {
  return `/@nimbalyst-extension/${slug}`;
}

/** Where the built bundle is emitted, and therefore its deployed URL. */
export function pinnedExtensionOutputPath(slug, version) {
  return `extensions/${slug}/${version}/index.js`;
}

/**
 * The env var pair the production build hands the Vite build: `_BUNDLE_DIR`
 * points at the temporary output of this extension's rebuild, `_BUNDLE_VERSION`
 * at the version its provenance recorded.
 */
export function pinnedExtensionEnvPrefix(slug) {
  return `NIMBALYST_PINNED_${screamingSlug(slug)}`;
}

/** The `define` identifier holding this extension's public bundle URL. */
export function pinnedExtensionUrlDefine(slug) {
  return `__PINNED_${screamingSlug(slug)}_EXTENSION_URL__`;
}

/** The `define` identifier holding this extension's inlined host manifest. */
export function pinnedExtensionManifestDefine(slug) {
  return `__PINNED_${screamingSlug(slug)}_EXTENSION_MANIFEST__`;
}
