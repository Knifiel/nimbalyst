/**
 * `dist/THIRD_PARTY_LICENSES.md`: the license of every third-party package the
 * browser view ships.
 *
 * Two sources. Vite lists what it bundles from node_modules (`build.license`,
 * written to `.vite/license.md`). The pinned editors arrive prebuilt, with their
 * own dependencies already inlined (Excalidraw's library in the drawing
 * editor, for one), so for each editor this walks its production dependencies
 * from its own package root and adds any package Vite did not list. First-party
 * `@nimbalyst/*` packages and the editors themselves are MIT and named once.
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

function packageRoot(name, fromDir) {
  const require = createRequire(path.join(fromDir, 'package.json'));
  for (const base of require.resolve.paths(name) ?? []) {
    const candidate = path.join(base, ...name.split('/'));
    if (existsSync(path.join(candidate, 'package.json'))) return candidate;
  }
  return null;
}

function licenseText(dir) {
  const file = readdirSync(dir).find((name) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(name));
  return file ? readFileSync(path.join(dir, file), 'utf8').trim() : null;
}

/** Production dependencies of each root, transitively, as name -> { version, license, text }. */
function walk(roots) {
  const found = new Map();
  const queue = roots.map((dir) => ({ dir, self: true }));
  const seen = new Set();
  while (queue.length) {
    const { dir, self } = queue.shift();
    if (seen.has(dir)) continue;
    seen.add(dir);
    const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    if (!self && !manifest.name.startsWith('@nimbalyst/') && !found.has(manifest.name)) {
      found.set(manifest.name, { version: manifest.version, license: typeof manifest.license === 'string' ? manifest.license : manifest.license?.type ?? 'see text', text: licenseText(dir) });
    }
    for (const dep of Object.keys(manifest.dependencies ?? {})) {
      const depDir = packageRoot(dep, dir);
      if (depDir) queue.push({ dir: depDir, self: false });
    }
  }
  return found;
}

export function writeThirdPartyLicenses({ distDir, editorRoots }) {
  const viteFile = path.join(distDir, '.vite', 'license.md');
  const vite = existsSync(viteFile) ? readFileSync(viteFile, 'utf8') : '';
  rmSync(path.join(distDir, '.vite'), { recursive: true, force: true });
  const listed = new Set([...vite.matchAll(/^## (\S+)/gm)].map((match) => match[1].replace(/ .*/, '')));
  const editors = Object.entries(editorRoots).map(([slug, dir]) => {
    const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return { slug, name: manifest.name, license: manifest.license ?? 'MIT' };
  });
  const extra = [...walk(Object.values(editorRoots)).entries()].filter(([name]) => !listed.has(name)).sort(([a], [b]) => a.localeCompare(b));
  const sections = [
    '# Third-party licenses',
    '',
    'The Nimbalyst wiki browser view (@nimbalyst/wiki-web) is MIT licensed. It includes these Nimbalyst editors, also first-party:',
    '',
    ...editors.map((editor) => `- ${editor.name} (${editor.slug}): ${editor.license}`),
    '',
    'and the third-party packages below.',
    '',
    vite.replace(/^# .*\n/, '').trim(),
    '',
    ...extra.flatMap(([name, info]) => [`## ${name} - ${info.version} (${info.license})`, '', info.text ?? `License: ${info.license}`, '']),
  ];
  writeFileSync(path.join(distDir, 'THIRD_PARTY_LICENSES.md'), `${sections.join('\n').trim()}\n`);
  return { vite: listed.size, editors: extra.length };
}
