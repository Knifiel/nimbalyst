#!/usr/bin/env node
// Refuse pushes outside a maintainer's allowlist. On 2026-10-10 a landing
// session pushed integration merges onto contributors' PR branches, putting a
// 2729-file merge commit on public main. The allowlist lives in local git config,
// never in the repo, so contributors pushing to their own forks are unaffected:
//
//   git config nimbalyst.pushAllowUrl 'github\.com[:/]nimbalyst/nimbalyst(\.git)?$'
//   git config nimbalyst.pushAllowRefs 'refs/heads/main,refs/tags/*'
//
// NIMBALYST_ALLOW_PUSH=1 lets a deliberate one-off push through.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function parsePushRefs(stdin) {
  return stdin
    .split('\n')
    .filter(Boolean)
    .map((line) => line.trim().split(/\s+/)[2])
    .filter(Boolean);
}

function refAllowed(ref, patterns) {
  return patterns.some((p) => (p.endsWith('*') ? ref.startsWith(p.slice(0, -1)) : ref === p));
}

export function checkPushDestination({ url, refs, config, override = false }) {
  if (override || (!config.urlPattern && !config.refs)) return { ok: true };
  if (config.urlPattern && !new RegExp(config.urlPattern).test(url)) {
    return { ok: false, reason: `remote ${url} is not in nimbalyst.pushAllowUrl` };
  }
  const patterns = (config.refs ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const denied = patterns.length ? refs.filter((ref) => !refAllowed(ref, patterns)) : [];
  if (denied.length) {
    return { ok: false, reason: `${denied.join(', ')} not in nimbalyst.pushAllowRefs` };
  }
  return { ok: true };
}

function gitConfig(key) {
  try {
    return execFileSync('git', ['config', '--get', key], { encoding: 'utf8' }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function main() {
  const url = process.argv[2] ?? '';
  const result = checkPushDestination({
    url,
    refs: parsePushRefs(readFileSync(0, 'utf8')),
    config: { urlPattern: gitConfig('nimbalyst.pushAllowUrl'), refs: gitConfig('nimbalyst.pushAllowRefs') },
    override: process.env.NIMBALYST_ALLOW_PUSH === '1',
  });
  if (!result.ok) {
    console.error(`[check-push-destination] ERROR: refusing to push: ${result.reason}.`);
    console.error('[check-push-destination] Agents must never push to contributor branches or side branches.');
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
