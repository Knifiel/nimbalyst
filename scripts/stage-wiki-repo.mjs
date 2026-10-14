#!/usr/bin/env node
// Assembles the public nimbalyst/nimbalyst-wiki repository from this one. That
// repository is publish output: the plugin, its bundled local servers, and the
// browser app, laid out so `/plugin marketplace add nimbalyst/nimbalyst-wiki`
// (Claude Code) and `codex plugin marketplace add nimbalyst/nimbalyst-wiki`
// install it without cloning the monorepo or running npm. The source stays
// here; changes land here and are staged out.
//
// Layout of the staged repository (the plugin is its root):
//
//   .claude-plugin/plugin.json, marketplace.json   Claude Code and Codex
//   .codex-plugin/, .codex-mcp.json, .mcp.json      from plugins/nimbalyst-wiki
//   skills/, scripts/, hooks/                       from plugins/nimbalyst-wiki
//   web/                                            built packages/wiki-web, served by openWikiInBrowser
//   README.md, LICENSE, FORMAT.md, CONTRIBUTING.md
//
//   node scripts/stage-wiki-repo.mjs <dir>                  build wiki-web, then stage into <dir>
//   node scripts/stage-wiki-repo.mjs <dir> --skip-web-build use the existing packages/wiki-web/dist
//
// <dir> is usually a clone of nimbalyst/nimbalyst-wiki. Everything in it but
// .git is replaced. Committing, tagging and pushing that clone is a separate,
// manual step.

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkGenerated, checkManifestVersions, listFiles, PLUGIN_DIR } from './build-wiki-plugin.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_PACKAGE = path.join(REPO_ROOT, 'packages/wiki-web');
const TEMPLATE_DIR = path.join(REPO_ROOT, 'scripts/wiki-repo');
const FORMAT_DOC = path.join(REPO_ROOT, 'packages/local-wiki/FORMAT.md');

/** Links in the plugin README that point into the monorepo, and where they point in the staged repository. */
const README_LINKS = [['../../packages/local-wiki/FORMAT.md', 'FORMAT.md']];

function fail(message) {
  console.error(message);
  process.exit(1);
}

/**
 * Plugin files that differ from an earlier staging of the same version. Installs
 * update by version, so a changed plugin published under an unchanged version
 * never reaches anyone who already has it. README.md is rewritten on staging and
 * changes nothing an install runs, so it is not compared.
 */
export function unbumpedChanges(pluginDir, outDir) {
  const versionIn = (dir) => {
    const file = path.join(dir, '.claude-plugin/plugin.json');
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).version : undefined;
  };
  const staged = versionIn(outDir);
  if (staged === undefined || staged !== versionIn(pluginDir)) return [];
  return listFiles(pluginDir).filter((rel) => {
    if (rel === 'README.md') return false;
    const previous = path.join(outDir, rel);
    return !existsSync(previous) || !readFileSync(previous).equals(readFileSync(path.join(pluginDir, rel)));
  });
}

export function stage(outDir, { buildWeb = true } = {}) {
  const stale = [...checkGenerated(), ...checkManifestVersions()];
  if (stale.length > 0) fail(`The plugin is stale; run node scripts/build-wiki-plugin.mjs first:\n  ${stale.join('\n  ')}`);
  const unbumped = unbumpedChanges(PLUGIN_DIR, outDir);
  if (unbumped.length > 0) {
    fail(`The plugin changed since the last staging but its version did not; bump .claude-plugin and .codex-plugin plugin.json:\n  ${unbumped.join('\n  ')}`);
  }

  if (buildWeb) execFileSync('pnpm', ['--filter', '@nimbalyst/wiki-web', 'run', 'build'], { cwd: REPO_ROOT, stdio: 'inherit' });
  const webDist = path.join(WEB_PACKAGE, 'dist');
  if (!existsSync(path.join(webDist, 'index.html'))) fail(`${webDist} has no index.html; build @nimbalyst/wiki-web first`);

  mkdirSync(outDir, { recursive: true });
  for (const entry of readdirSync(outDir)) {
    if (entry !== '.git') rmSync(path.join(outDir, entry), { recursive: true, force: true });
  }

  cpSync(PLUGIN_DIR, outDir, { recursive: true });
  cpSync(webDist, path.join(outDir, 'web'), { recursive: true });
  cpSync(TEMPLATE_DIR, outDir, { recursive: true });
  cpSync(FORMAT_DOC, path.join(outDir, 'FORMAT.md'));

  let readme = readFileSync(path.join(PLUGIN_DIR, 'README.md'), 'utf8');
  for (const [from, to] of README_LINKS) {
    if (!readme.includes(`](${from})`)) fail(`README.md no longer links ${from}; update README_LINKS in scripts/stage-wiki-repo.mjs`);
    readme = readme.replaceAll(`](${from})`, `](${to})`);
  }
  writeFileSync(path.join(outDir, 'README.md'), readme);

  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain', '--', 'plugins/nimbalyst-wiki', 'packages/cli', 'packages/local-wiki', 'packages/wiki-web', 'scripts/wiki-repo'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim();
  const version = JSON.parse(readFileSync(path.join(PLUGIN_DIR, '.claude-plugin/plugin.json'), 'utf8')).version;
  writeFileSync(path.join(outDir, 'SOURCE'), `Staged from https://github.com/nimbalyst/nimbalyst at ${commit}${dirty ? ' (with uncommitted changes)' : ''}\n`);
  return { version, commit, dirty: Boolean(dirty) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outArg = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
  if (!outArg) fail('usage: node scripts/stage-wiki-repo.mjs <dir> [--skip-web-build]');
  const outDir = path.resolve(outArg);
  if (outDir === REPO_ROOT || REPO_ROOT.startsWith(outDir + path.sep)) fail(`refusing to stage into ${outDir}: it holds this repository`);
  const result = stage(outDir, { buildWeb: !process.argv.includes('--skip-web-build') });
  console.log(`Staged nimbalyst-wiki ${result.version} into ${outDir}${result.dirty ? ' (source has uncommitted changes)' : ''}.`);
}
