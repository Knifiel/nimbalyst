#!/usr/bin/env node
// Whether the marketplace Worker (extensions.nimbalyst.com, not the extensions
// it serves; see marketplace-status.mjs for those) changed since its last
// production deploy. The baseline is the commit /health reports, which
// deploy.sh sets. A deploy older than that reports none; the baseline then
// falls back to the last commit before the latest `wrangler deployments`
// entry, which can be off by a commit.
//
//   node scripts/worker-status.mjs [--json]

import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEALTH_URL = 'https://extensions.nimbalyst.com/health';
/** What the deployed Worker is built from, relative to this package. package.json carries its dependencies (and over-reports script edits). */
export const WATCH = ['src', 'wrangler.toml', 'package.json'];

function run(cmd, args, options = {}) {
  try {
    return execFileSync(cmd, args, { cwd: PACKAGE_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...options }).trimEnd();
  } catch {
    return null;
  }
}

function lines(text) {
  return text ? text.split('\n').filter(Boolean) : [];
}

/** The deploy decision from the facts. `health` is the parsed /health body or null when unreachable. */
export function decide({ health, baseline, commits, uncommitted }) {
  if (!health) return { status: 'UNREACHABLE', note: `${HEALTH_URL} did not answer; check the Worker before deploying over it` };
  if (!baseline) return { status: 'deploy', note: 'no baseline commit could be found; deploying records one' };
  if (commits.length > 0 || uncommitted.length > 0) return { status: 'deploy', note: `live ${health.version}, sources changed since` };
  return { status: 'up to date', note: `live ${health.version}` };
}

async function fetchHealth() {
  try {
    const response = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(5000) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

function lastDeployTime() {
  const out = run('pnpm', ['exec', 'wrangler', 'deployments', 'list', '--env', 'production', '--json'], {
    env: { ...process.env, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config/nimbalyst') },
  });
  try {
    const deployments = JSON.parse(out ?? '');
    return deployments.map((d) => d.created_on).sort().pop() ?? null;
  } catch {
    return null;
  }
}

export async function workerStatus() {
  const health = await fetchHealth();
  let baseline = null;
  if (health?.commit && run('git', ['cat-file', '-e', `${health.commit}^{commit}`]) !== null) {
    baseline = { sha: health.commit, how: '/health commit' };
  } else if (health) {
    const at = lastDeployTime();
    const sha = at ? run('git', ['rev-list', '-1', `--before=${at}`, 'HEAD']) : null;
    if (sha) baseline = { sha, how: `last commit before the latest deployment (${at}), estimated` };
  }
  const commits = baseline ? lines(run('git', ['log', '--oneline', `${baseline.sha}..HEAD`, '--', ...WATCH])) : [];
  const uncommitted = lines(run('git', ['status', '--porcelain', '--', ...WATCH]));
  return { worker: 'nimbalyst-marketplace', health, baseline, commits, uncommitted, ...decide({ health, baseline, commits, uncommitted }) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = await workerStatus();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log(`\nmarketplace Worker: ${r.status} (${r.note})`);
    if (r.baseline) console.log(`  baseline ${r.baseline.sha.slice(0, 9)} (${r.baseline.how})`);
    if (r.commits.length) console.log(`  ${r.commits.length} commit(s) since:\n    ${r.commits.join('\n    ')}`);
    if (r.uncommitted.length) console.log(`  UNCOMMITTED:\n    ${r.uncommitted.join('\n    ')}`);
  }
}
