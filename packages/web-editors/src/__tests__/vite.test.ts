// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseAst } from 'vite';
import {
  PINNED_EXTENSIONS,
  pinnedExtensionDevUrl,
  pinnedExtensionEntryId,
  pinnedExtensionEnvPrefix,
  pinnedExtensionManifestDefine,
  pinnedExtensionUrlDefine,
} from '../pinnedExtensions.mjs';
import {
  findPinnedExtensionRoot,
  pinnedExtensionBundleEntries,
  pinnedExtensionDefines,
  resolvePinnedExtensionBundle,
  type PinnedExtensionBundle,
} from '../vite.mjs';

const CSV_PIN = { package: '@nimbalyst/extension-csv-spreadsheet', slug: 'csv-spreadsheet' };
const MOCKUPLM_PIN = { package: '@nimbalyst/mockuplm', slug: 'mockuplm' };
const CSV_VERSION_OVERRIDE = `${pinnedExtensionEnvPrefix(CSV_PIN.slug)}_BUNDLE_VERSION`;

const temporaryDirectories: string[] = [];
const originalPinnedVersionOverride = process.env[CSV_VERSION_OVERRIDE];

function createExtensionFixture(
  {
    built,
    entrySource = 'export const loaded = true;\n',
    manifestVersion = '4.5.6',
    pin = CSV_PIN,
    writeManifest = true,
  }:
  {
    built: boolean;
    entrySource?: string;
    manifestVersion?: unknown;
    pin?: { package: string; slug: string };
    writeManifest?: boolean;
  },
): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `web-editors-${pin.slug}-`));
  temporaryDirectories.push(root);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: pin.package,
    version: '1.2.3',
  }));
  if (writeManifest) {
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
      id: `com.nimbalyst.${pin.slug}`,
      version: manifestVersion,
    }));
  }
  if (built) {
    fs.mkdirSync(path.join(root, 'dist'));
    fs.writeFileSync(path.join(root, 'dist', 'index.js'), entrySource);
    fs.writeFileSync(path.join(root, 'dist', 'index.css'), '.editor {}\n');
  }
  return root;
}

function resolveFixtureBundle(
  installedRoot: string,
  { command = 'build', mode = 'production', pin = CSV_PIN } = {},
): PinnedExtensionBundle {
  return resolvePinnedExtensionBundle({
    command: command as 'build' | 'serve',
    installedRoot,
    mode,
    pin,
    resolveFrom: installedRoot,
  });
}

async function loadPinnedEntrySource(installedRoot: string): Promise<string> {
  const bundle = resolveFixtureBundle(installedRoot);
  const plugin = pinnedExtensionBundleEntries([bundle], { parseAst });
  if (typeof plugin.load !== 'function') throw new Error('Pinned plugin has no load hook');
  return String(await plugin.load.call({} as never, `\0${bundle.entryId}`));
}

afterEach(() => {
  delete process.env.NIMBALYST_EXTENSION_CHECKOUTS;
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  if (originalPinnedVersionOverride === undefined) {
    delete process.env[CSV_VERSION_OVERRIDE];
  } else {
    process.env[CSV_VERSION_OVERRIDE] = originalPinnedVersionOverride;
  }
});

describe('pinned extension development bundle', () => {
  it('takes the emitted build path version from manifest.json, not package.json', () => {
    const bundle = resolveFixtureBundle(createExtensionFixture({ built: true }));

    expect(bundle.version).toBe('4.5.6');
    expect(bundle.outputPath).toBe('extensions/csv-spreadsheet/4.5.6/index.js');
  });

  it('keeps the production orchestrator version override working', () => {
    const installedRoot = createExtensionFixture({ built: true });
    process.env[CSV_VERSION_OVERRIDE] = '7.8.9';

    const bundle = resolveFixtureBundle(installedRoot);

    expect(bundle.version).toBe('7.8.9');
    expect(bundle.outputPath).toBe('extensions/csv-spreadsheet/7.8.9/index.js');
  });

  it.each([
    ['missing', { writeManifest: false }],
    ['without a usable version', { manifestVersion: '' }],
  ])('fails clearly when manifest.json is %s', (_label, fixtureOptions) => {
    const installedRoot = createExtensionFixture({ built: true, ...fixtureOptions });

    expect(() => resolveFixtureBundle(installedRoot)).toThrow(/manifest\.json.*version/i);
  });

  it('fails Vite startup with the exact rebuild action when the extension is not built', () => {
    const installedRoot = createExtensionFixture({ built: false });

    expect(() => resolveFixtureBundle(installedRoot, {
      command: 'serve',
      mode: 'development',
    })).toThrow(`Run "pnpm --dir ${installedRoot} run build", then retry.`);
  });

  it('routes the stable dev URL to the same single virtual module as the build entry', async () => {
    const installedRoot = createExtensionFixture({ built: true });
    const bundle = resolveFixtureBundle(installedRoot, { command: 'serve', mode: 'development' });
    const plugin = pinnedExtensionBundleEntries([bundle], { parseAst });
    if (typeof plugin.resolveId !== 'function' || typeof plugin.load !== 'function') {
      throw new Error('Pinned plugin hooks are not callable');
    }

    const devModuleId = await plugin.resolveId.call({} as never, pinnedExtensionDevUrl(CSV_PIN.slug));
    const buildModuleId = await plugin.resolveId.call({} as never, bundle.entryId);
    expect(devModuleId).toBe(buildModuleId);
    expect(bundle.publicUrl).toBe(pinnedExtensionDevUrl(CSV_PIN.slug));

    const moduleSource = await plugin.load.call({} as never, String(devModuleId));
    expect(moduleSource).toContain(JSON.stringify(bundle.entryPath));
    expect(moduleSource).toContain(JSON.stringify(`${bundle.cssPath}?inline`));
  });

  // One plugin now serves every pinned row. If resolveId or load collapsed two
  // rows onto one module, both entries would build from the same bundle and the
  // console would ship one editor twice under two URLs — which looks like a
  // successful build and fails only when a document of the second type opens.
  it('keeps each pinned row on its own module, bundle and emitted path', async () => {
    const csv = resolveFixtureBundle(createExtensionFixture({ built: true }));
    const mockuplm = resolveFixtureBundle(
      createExtensionFixture({ built: true, manifestVersion: '1.0.3', pin: MOCKUPLM_PIN }),
      { pin: MOCKUPLM_PIN },
    );
    const plugin = pinnedExtensionBundleEntries([csv, mockuplm], { parseAst });
    if (typeof plugin.resolveId !== 'function' || typeof plugin.load !== 'function') {
      throw new Error('Pinned plugin hooks are not callable');
    }

    expect(csv.outputPath).toBe('extensions/csv-spreadsheet/4.5.6/index.js');
    expect(mockuplm.outputPath).toBe('extensions/mockuplm/1.0.3/index.js');

    for (const bundle of [csv, mockuplm]) {
      const moduleId = await plugin.resolveId.call({} as never, bundle.entryId);
      expect(moduleId).toBe(`\0${pinnedExtensionEntryId(bundle.slug)}`);
      const moduleSource = String(await plugin.load.call({} as never, String(moduleId)));
      expect(moduleSource).toContain(JSON.stringify(bundle.entryPath));
      // The injected <style> id is what keeps two extensions' CSS apart.
      expect(moduleSource).toContain(`nimbalyst-extension-${bundle.slug}-${bundle.version}`);
    }

    expect(await plugin.resolveId.call({} as never, 'virtual:not-a-pinned-extension')).toBeNull();
  });

  // `export *` deliberately omits `default`, so the pinned entry has to add it
  // or a defaulted extension would arrive in the browser missing its main export.
  it('re-exports the extension default only when the extension has one', async () => {
    const withoutDefault = await loadPinnedEntrySource(
      createExtensionFixture({ built: true }),
    );
    expect(withoutDefault).not.toContain('export { default }');

    const withDefault = await loadPinnedEntrySource(createExtensionFixture({
      built: true,
      entrySource: 'const extension = {};\nexport default extension;\n',
    }));
    expect(withDefault).toContain('export { default }');
  });

  it('finds a pin in its sibling checkout and defines every pin the app did not build as null', () => {
    const checkouts = fs.mkdtempSync(path.join(os.tmpdir(), 'web-editors-'));
    const app = fs.mkdtempSync(path.join(os.tmpdir(), 'web-editors-app-'));
    temporaryDirectories.push(checkouts, app);
    fs.writeFileSync(path.join(app, 'package.json'), '{}');
    const mindmapPin = PINNED_EXTENSIONS.find((pin) => pin.slug === 'mindmap')!;
    expect(findPinnedExtensionRoot(mindmapPin, app)).not.toBe(path.join(checkouts, 'nimbalyst-mindmap'));

    process.env.NIMBALYST_EXTENSION_CHECKOUTS = checkouts;
    const root = path.join(checkouts, 'nimbalyst-mindmap');
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: mindmapPin.package }));
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ id: 'com.example.mindmap', name: 'Mind map', version: '1.2.3', marketplace: { icon: 'hub', screenshots: ['x.png'] } }));
    fs.writeFileSync(path.join(root, 'dist/index.js'), 'export const components = {};');
    fs.writeFileSync(path.join(root, 'dist/index.css'), '');
    expect(findPinnedExtensionRoot(mindmapPin, app)).toBe(root);

    const bundle = resolvePinnedExtensionBundle({ command: 'build', mode: 'production', pin: mindmapPin, resolveFrom: app });
    expect(bundle.publicUrl).toBe('/extensions/mindmap/1.2.3/index.js');

    const defines = pinnedExtensionDefines([bundle]);
    expect(JSON.parse(defines[pinnedExtensionManifestDefine('mindmap')]!)).toEqual({
      id: 'com.example.mindmap', name: 'Mind map', version: '1.2.3', marketplace: { icon: 'hub' },
    });
    for (const pin of PINNED_EXTENSIONS.filter((candidate) => candidate.slug !== 'mindmap')) {
      expect(defines[pinnedExtensionUrlDefine(pin.slug)]).toBe('null');
      expect(defines[pinnedExtensionManifestDefine(pin.slug)]).toBe('null');
    }
  });
});
