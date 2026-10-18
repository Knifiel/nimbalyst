/**
 * Builds the browser view: each pinned editor first, in production mode and
 * into a cache directory (never into the extension's own checkout), then the
 * app with Vite, then the size report.
 *
 * Production mode matters: an extension's dev build imports
 * `react/jsx-dev-runtime`, whose production export is undefined, so a dev
 * bundle would crash the first time its editor rendered.
 *
 * A pin that lives in its own repo (mind map) is found as a sibling checkout of
 * stravu-editor or under NIMBALYST_EXTENSION_CHECKOUTS; see
 * `@nimbalyst/web-editors/vite`. Missing it fails the build.
 *
 * Last, the editors' pure document code is bundled for Node into
 * `dist/models/editor-models.mjs`, which `nim mcp` loads to edit mind map and
 * drawing pages as files, and `nim wiki move-to-team` loads to write editor
 * pages into team documents (see `editor-models.entry.mjs`).
 */
import { spawnSync } from 'node:child_process';
import { build as esbuild } from 'esbuild';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PINNED_EXTENSIONS, pinnedExtensionEnvPrefix } from '@nimbalyst/web-editors/pinned';
import { findPinnedExtensionRoot } from '@nimbalyst/web-editors/vite';
import { writeThirdPartyLicenses } from './third-party-licenses.mjs';
import { WIKI_EDITOR_SLUGS, wikiEditorBuildDir } from './wikiEditorPins.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

function run(command, args, options) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.status !== 0) {
    console.error(`[wiki-web] ${options.label} failed${result.error ? `: ${result.error.message}` : ` with exit code ${result.status}`}`);
    process.exit(result.status || 1);
  }
}

const env = { ...process.env };
const roots = {};
for (const slug of WIKI_EDITOR_SLUGS) {
  const pin = PINNED_EXTENSIONS.find((candidate) => candidate.slug === slug);
  if (!pin) throw new Error(`[wiki-web] ${slug} is not a pinned extension in @nimbalyst/web-editors`);
  const root = findPinnedExtensionRoot(pin, packageRoot);
  if (!root) {
    const where = pin.checkout ? ` Clone it beside stravu-editor as ${pin.checkout}/ (or set NIMBALYST_EXTENSION_CHECKOUTS) and install its dependencies.` : ' Run pnpm install.';
    console.error(`[wiki-web] Could not find ${pin.package}.${where}`);
    process.exit(1);
  }
  roots[slug] = root;
  const outDir = wikiEditorBuildDir(packageRoot, slug);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  console.log(`[wiki-web] building ${pin.package} from ${root}`);
  // The extension SDK's manifest check looks for manifest.main and .styles in the
  // extension's own folder even when --outDir sends the build elsewhere, so a
  // fresh checkout (CI) fails it. Build once in place first when they are missing.
  const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  if ([manifest.main, manifest.styles].some((file) => file && !existsSync(path.join(root, file)))) {
    run(pnpm, ['run', 'build'], { cwd: root, env: { ...process.env, NODE_ENV: 'production' }, label: `${pin.package} build in place` });
  }
  // No `--` separator: pnpm would forward it and Vite would ignore --outDir.
  run(pnpm, ['run', 'build', '--outDir', outDir, '--emptyOutDir'], { cwd: root, env: { ...process.env, NODE_ENV: 'production' }, label: `${pin.package} build` });
  env[`${pinnedExtensionEnvPrefix(slug)}_BUNDLE_DIR`] = outDir;
}

run(pnpm, ['exec', 'vite', 'build'], { cwd: packageRoot, env, label: 'vite build' });

await esbuild({
  entryPoints: [path.join(packageRoot, 'scripts/editor-models.entry.mjs')],
  outfile: path.join(packageRoot, 'dist/models/editor-models.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  logLevel: 'warning',
  // The document room client reads Vite's env for its diagnostics switch; nim is a production build.
  define: { 'import.meta.env.DEV': 'false', 'import.meta.env.VITE_COLLAB_CONNECTION_DIAGNOSTICS': '"off"' },
  alias: {
    '@nimbalyst/mindmap-model': path.join(roots.mindmap, 'src/model.ts'),
    '@nimbalyst/excalidraw-elements': path.join(roots.excalidraw, 'src/utils/elementFactory.ts'),
    '@nimbalyst/excalidraw-layout': path.join(roots.excalidraw, 'src/layout/LayoutEngine.ts'),
    '@nimbalyst/mindmap-codec': path.join(roots.mindmap, 'src/collab/codec.ts'),
    '@nimbalyst/canvas-codec': path.join(packageRoot, '../runtime/src/canvas/canvasCollabCodec.ts'),
    '@nimbalyst/html-page-codec': path.join(packageRoot, '../runtime/src/ui/htmlEmbed/htmlPageCodec.ts'),
    '@nimbalyst/document-sync': path.join(packageRoot, '../runtime/src/sync/DocumentSync.ts'),
    // One yjs for every codec. The mind map checkout has its own node_modules,
    // and a Y.Map from a second copy fails inside a Y.Doc from the first.
    yjs: path.join(path.dirname(createRequire(path.join(packageRoot, 'package.json')).resolve('yjs')), 'yjs.mjs'),
  },
});
const licenses = writeThirdPartyLicenses({ distDir: path.join(packageRoot, 'dist'), editorRoots: roots });
console.log(`[wiki-web] THIRD_PARTY_LICENSES.md: ${licenses.vite} packages bundled by Vite, ${licenses.editors} more inside the editors`);

run(process.execPath, ['scripts/check-size.mjs'], { cwd: packageRoot, env, label: 'size check' });
