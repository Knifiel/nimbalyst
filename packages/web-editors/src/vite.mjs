/**
 * The build half of pinning an extension into a browser app: find the built
 * bundle, inline its manifest, and emit a lazy entry that re-exports the
 * bundle and injects its CSS.
 *
 * Moved here from the web console's `vite.config.ts` so the local wiki's
 * browser view builds editors the same way. Plain `.mjs` (typed by
 * `vite.d.mts`) so a Vite config in either repo can import it without a
 * TypeScript loader, and free of a `vite` import so each app's own Vite
 * version is the only one in its build.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PINNED_EXTENSIONS,
  PINNED_EXTENSION_VERSION_PATTERN,
  pinnedExtensionDevUrl,
  pinnedExtensionEntryId,
  pinnedExtensionEnvPrefix,
  pinnedExtensionManifestDefine,
  pinnedExtensionOutputPath,
  pinnedExtensionUrlDefine,
} from './pinnedExtensions.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The browser stand-in for `@nimbalyst/runtime`; alias the bare specifier to it. */
export const pinnedRuntimeBridgePath = path.join(here, 'pinnedRuntimeBridge.tsx');

/** This package's source, which a dev server must be allowed to serve. */
export const webEditorsSourceDir = here;

/** The desktop runtime's source in this checkout, which the bridge re-exports from. */
export const runtimeSourceDir = path.resolve(here, '../../runtime/src');

/** Where a pin's `checkout` is looked for when the app does not depend on the package. */
function checkoutRoots() {
  const roots = [];
  if (process.env.NIMBALYST_EXTENSION_CHECKOUTS) roots.push(process.env.NIMBALYST_EXTENSION_CHECKOUTS);
  // A sibling of the stravu-editor checkout this file lives in.
  roots.push(path.resolve(here, '../../../..'));
  return roots;
}

function packageNameAt(candidate) {
  try {
    return JSON.parse(fs.readFileSync(path.join(candidate, 'package.json'), 'utf8')).name;
  } catch {
    return undefined;
  }
}

/**
 * The installed root of a pinned package: the app's own node_modules first,
 * then the pin's sibling checkout. `null` when neither has it.
 */
export function findPinnedExtensionRoot(pin, resolveFrom) {
  const require = createRequire(path.join(resolveFrom, 'package.json'));
  const packageSegments = pin.package.split('/');
  const installed = (require.resolve.paths(pin.package) ?? [])
    .map((searchPath) => path.join(searchPath, ...packageSegments))
    .find((candidate) => packageNameAt(candidate) === pin.package);
  if (installed) return installed;
  if (!pin.checkout) return null;
  return checkoutRoots()
    .map((root) => path.join(root, pin.checkout))
    .find((candidate) => packageNameAt(candidate) === pin.package) ?? null;
}

/**
 * A pinned editor is reached through the app's dependency (or the pin's
 * sibling checkout), and emitted at a versioned URL in the app's dist. In the
 * web console, scripts/build-production.mjs rebuilds it first and records
 * source provenance; see that script before changing how versions are read.
 */
export function resolvePinnedExtensionBundle({
  command,
  installedRoot: installedRootOverride,
  mode,
  pin,
  resolveFrom,
  label = 'web-editors',
}) {
  const installedRoot = installedRootOverride ?? findPinnedExtensionRoot(pin, resolveFrom);
  if (!installedRoot) {
    throw new Error(
      `[${label}] Could not resolve installed ${pin.package}. Run pnpm install, then retry.`,
    );
  }
  const extensionManifestPath = path.join(installedRoot, 'manifest.json');
  let extensionManifest;
  try {
    extensionManifest = JSON.parse(fs.readFileSync(extensionManifestPath, 'utf8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `[${label}] Could not read ${pin.package} manifest.json at `
      + `${extensionManifestPath}: ${detail}. Ensure the file exists, contains valid JSON, `
      + 'and sets a usable "version" before building.',
    );
  }
  const manifestVersion = typeof extensionManifest.version === 'string'
    ? extensionManifest.version
    : '';
  if (!PINNED_EXTENSION_VERSION_PATTERN.test(manifestVersion)) {
    throw new Error(
      `[${label}] ${pin.package} manifest.json has no usable version. `
      + 'Set "version" to a non-empty value containing only letters, numbers, dots, underscores, or hyphens.',
    );
  }
  const environmentPrefix = pinnedExtensionEnvPrefix(pin.slug);
  const version = process.env[`${environmentPrefix}_BUNDLE_VERSION`] ?? manifestVersion;
  if (!PINNED_EXTENSION_VERSION_PATTERN.test(version)) {
    throw new Error(
      `[${label}] Invalid pinned ${pin.slug} extension version: ${String(version)}`,
    );
  }

  const bundleDirectory = process.env[`${environmentPrefix}_BUNDLE_DIR`]
    ?? path.join(installedRoot, 'dist');
  const entryPath = path.join(bundleDirectory, 'index.js');
  const cssPath = path.join(bundleDirectory, 'index.css');
  // A build would otherwise fail later with an unresolved import far from the cause.
  if (mode !== 'test' && (!fs.existsSync(entryPath) || !fs.existsSync(cssPath))) {
    throw new Error(
      `[${label}] The pinned ${pin.slug} extension is not built at ${bundleDirectory}. `
      + `Run "pnpm --dir ${installedRoot} run build", then retry.`,
    );
  }

  const outputPath = pinnedExtensionOutputPath(pin.slug, version);
  return {
    ...pin,
    cssPath,
    entryId: pinnedExtensionEntryId(pin.slug),
    entryPath,
    installedRoot,
    outputPath,
    publicUrl: command === 'serve' ? pinnedExtensionDevUrl(pin.slug) : `/${outputPath}`,
    version,
  };
}

/**
 * The pinned extension's `manifest.json`, reduced to what a host reads.
 *
 * The manifest is inlined into the app's own payload while the bundle it
 * describes stays lazy, which is what lets a document-type catalog know a
 * document has an owner before paying to download the editor for it. It is
 * read from the extension rather than restated in app source so the app
 * cannot claim a file pattern, a component name or a collaboration capability
 * the extension no longer ships.
 *
 * Only the `marketplace` block is trimmed: screenshots, changelog and listing
 * prose are for the extension gallery, and they would ride in the initial
 * payload for nothing.
 */
export function readPinnedExtensionHostManifest(installedRoot) {
  const manifest = JSON.parse(fs.readFileSync(path.join(installedRoot, 'manifest.json'), 'utf8'));
  const marketplace = manifest.marketplace;
  return {
    ...manifest,
    ...(marketplace ? { marketplace: { icon: marketplace.icon } } : {}),
  };
}

/**
 * The `define` table for every row of `PINNED_EXTENSIONS`: the URL and inlined
 * manifest of each bundle the app builds, and `null` for every row it does not,
 * so the shared loader compiles and simply skips those.
 */
export function pinnedExtensionDefines(bundles) {
  const bySlug = new Map(bundles.map((bundle) => [bundle.slug, bundle]));
  return Object.fromEntries(PINNED_EXTENSIONS.flatMap(({ slug }) => {
    const bundle = bySlug.get(slug);
    return [
      [pinnedExtensionUrlDefine(slug), bundle ? JSON.stringify(bundle.publicUrl) : 'null'],
      [
        pinnedExtensionManifestDefine(slug),
        bundle ? JSON.stringify(readPinnedExtensionHostManifest(bundle.installedRoot)) : 'null',
      ],
    ];
  }));
}

/**
 * Whether an extension's built entry has a default export.
 *
 * `export * from` deliberately does not re-export `default`, so the pinned entry
 * has to add it explicitly or lose it. Detecting it beats assuming: the named
 * exports were already lost once, silently, and a pinned bundle that grows a
 * default export later would go the same way.
 *
 * `parseAst` is the app's own (`import { parseAst } from 'vite'`).
 */
export function hasDefaultExport(entryPath, parseAst) {
  const program = parseAst(fs.readFileSync(entryPath, 'utf8'));
  return program.body.some((node) => (
    node.type === 'ExportDefaultDeclaration'
    || (node.type === 'ExportAllDeclaration' && node.exported?.type === 'Identifier' && node.exported.name === 'default')
    || (node.type === 'ExportNamedDeclaration' && node.specifiers.some(
      (specifier) => specifier.exported.type === 'Identifier' && specifier.exported.name === 'default',
    ))
  ));
}

/**
 * The Vite plugin that serves each pinned bundle as a virtual entry: its CSS
 * injected once as a `<style>`, its exports re-exported. With `provenance`, a
 * copy of the build's source record is emitted beside each entry.
 */
export function pinnedExtensionBundleEntries(bundles, { parseAst, provenance } = {}) {
  if (typeof parseAst !== 'function') {
    throw new Error('[web-editors] pinnedExtensionBundleEntries needs the app\'s parseAst (from "vite")');
  }
  // One plugin for the whole table rather than one per row: a resolveId that
  // consults a map cannot drift out of step with a load that consults another.
  const bundlesByResolvedId = new Map(
    bundles.map((bundle) => [`\0${bundle.entryId}`, bundle]),
  );
  const resolvedIdBySpecifier = new Map(
    bundles.flatMap((bundle) => [bundle.entryId, pinnedExtensionDevUrl(bundle.slug)]
      .map((specifier) => [specifier, `\0${bundle.entryId}`])),
  );
  return {
    name: 'web-console-pinned-extension-bundle-entries',
    resolveId(id) {
      return resolvedIdBySpecifier.get(id) ?? null;
    },
    load(id) {
      const bundle = bundlesByResolvedId.get(id);
      if (!bundle) return null;
      const cssImport = JSON.stringify(`${bundle.cssPath}?inline`);
      const extensionImport = JSON.stringify(bundle.entryPath);
      const defaultReExport = hasDefaultExport(bundle.entryPath, parseAst)
        ? `export { default } from ${extensionImport};\n`
        : '';
      return `
import extensionCss from ${cssImport};

const styleId = 'nimbalyst-extension-${bundle.slug}-${bundle.version}';
if (typeof document !== 'undefined' && !document.getElementById(styleId)) {
  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = extensionCss;
  document.head.appendChild(style);
}

export * from ${extensionImport};
${defaultReExport}`;
    },
    generateBundle() {
      if (!provenance) return;
      // One copy per pinned extension, beside its own entry: the emitted URL is
      // versioned per extension, so a single shared record would have no
      // directory to live in that every entry can be checked against.
      for (const bundle of bundles) {
        this.emitFile({
          type: 'asset',
          fileName: `extensions/${bundle.slug}/${bundle.version}/provenance.json`,
          source: `${JSON.stringify(provenance, null, 2)}\n`,
        });
      }
    },
  };
}

/**
 * `rollupOptions.input` entries and the `entryFileNames` that put each pinned
 * bundle at its versioned path. Merge into the app's own build options.
 */
export function pinnedExtensionBuildInputs(bundles) {
  return Object.fromEntries(bundles.map((bundle) => [bundle.slug, bundle.entryId]));
}

export function pinnedExtensionEntryFileNames(bundles, fallback = 'assets/[name]-[hash].js') {
  return (chunkInfo) => {
    const bundle = bundles.find((candidate) => candidate.slug === chunkInfo.name);
    return bundle ? bundle.outputPath : fallback;
  };
}
