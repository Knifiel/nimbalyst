// @vitest-environment node

/**
 * Guards the two release-tooling failures that are invisible until a user hits
 * them: a registry that lists the same extension twice (so an old build can win
 * a download), and a published bundle whose collaboration declaration no longer
 * matches the local manifest.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const statusScript = path.resolve(__dirname, '../scripts/marketplace-status.mjs');
const registryScript = path.resolve(__dirname, '../scripts/generate-registry.sh');
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function packageFixture(dir: string, id: string, version: string): void {
  const staging = path.join(dir, `staging-${version}`);
  mkdirSync(staging, { recursive: true });
  writeFileSync(
    path.join(staging, 'manifest.json'),
    JSON.stringify({ id, name: 'Fixture', version, description: 'fixture' }),
  );
  execFileSync('zip', ['-q', '-j', path.join(dir, `${id}-${version}.nimext`), path.join(staging, 'manifest.json')]);
  writeFileSync(path.join(dir, `${id}-${version}.nimext.sha256`), 'deadbeef');
}

describe('generate-registry.sh', () => {
  it('keeps only the newest build when dist still holds an older one', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'nimbalyst-registry-'));
    tempRoots.push(root);

    // 1.0.10 must beat 1.0.9 -- a string compare would pick the wrong one.
    packageFixture(root, 'com.nimbalyst.fixture', '1.0.9');
    packageFixture(root, 'com.nimbalyst.fixture', '1.0.10');

    const output = path.join(root, 'registry.json');
    execFileSync(registryScript, ['--input-dir', root, '--output', output], { stdio: 'pipe' });

    const registry = JSON.parse(readFileSync(output, 'utf8'));
    const fixtures = registry.extensions.filter(
      (e: { id: string }) => e.id === 'com.nimbalyst.fixture',
    );

    expect(fixtures).toHaveLength(1);
    expect(fixtures[0].version).toBe('1.0.10');
    expect(fixtures[0].downloadUrl).toContain('/1.0.10');
  });
});

describe('marketplace-status helpers', () => {
  it('orders versions numerically, not lexically', async () => {
    const { compareVersions } = await import(statusScript);
    expect(compareVersions('1.0.10', '1.0.9')).toBe(1);
    expect(compareVersions('1.0.2', '1.0.2')).toBe(0);
    expect(compareVersions('0.9.0', '1.0.0')).toBe(-1);
  });

  it('flags a live build still offering a share path the manifest withdrew', async () => {
    const { collaborationDrift } = await import(statusScript);

    const local = {
      contributions: {
        customEditors: [
          { filePatterns: ['*.mockup.html'], collaboration: { supported: true } },
          { filePatterns: ['*.mockupproject'], collaboration: { supported: false } },
        ],
      },
    };
    const published = {
      contributions: {
        customEditors: [
          { filePatterns: ['*.mockup.html'], collaboration: { supported: true } },
          { filePatterns: ['*.mockupproject'], collaboration: { supported: true } },
        ],
      },
    };

    expect(collaborationDrift(local, published)).toEqual([
      { pattern: '*.mockupproject', local: false, published: true },
    ]);
    expect(collaborationDrift(local, local)).toEqual([]);
  });

  it('treats matching versions with unreleased source as needing a bump', async () => {
    const { classify } = await import(statusScript);

    expect(classify({ localVersion: '1.0.2', liveVersion: '1.0.2', sourceChanged: false }))
      .toBe('up to date');
    expect(classify({ localVersion: '1.0.2', liveVersion: '1.0.2', sourceChanged: true }))
      .toBe('bump+publish');
    expect(classify({ localVersion: '1.0.3', liveVersion: '1.0.2', sourceChanged: false }))
      .toBe('publish (already bumped)');
    expect(classify({ localVersion: '0.4.0', liveVersion: undefined, sourceChanged: false }))
      .toBe('never published');
    // Drift alone must not be silently tolerated just because versions match.
    expect(classify({
      localVersion: '1.0.2',
      liveVersion: '1.0.2',
      sourceChanged: false,
      collabDrift: [{ pattern: '*.mockupproject', local: false, published: true }],
    })).toBe('bump+publish (collab drift)');
  });

  it('ignores the shipping comment markers when reading the release list', async () => {
    const { parseReleaseList } = await import(statusScript);
    expect(parseReleaseList('# comment\n../extensions/git\n\n../../../nimbalyst-slides|skip-build\n'))
      .toEqual([
        { relativePath: '../extensions/git', skipBuild: false },
        { relativePath: '../../../nimbalyst-slides', skipBuild: true },
      ]);
  });
});

describe('marketplace Worker deploy record', () => {
  it('reports the commit deploy.sh injects, which worker-status diffs from', async () => {
    const { default: worker } = await import('../src/index');
    const env = { VERSION: '0.1.1', GIT_COMMIT: 'a'.repeat(40) } as unknown as Parameters<typeof worker.fetch>[1];
    const body = await (await worker.fetch(new Request('https://extensions.nimbalyst.com/health'), env)).json();
    expect(body).toMatchObject({ version: '0.1.1', commit: 'a'.repeat(40) });
  });

  it('deploys only when the Worker sources moved past the live commit', async () => {
    const { decide } = await import(path.resolve(__dirname, '../scripts/worker-status.mjs'));
    const health = { version: '0.1.1', commit: 'abc' };
    const baseline = { sha: 'abc', how: '/health commit' };
    expect(decide({ health, baseline, commits: [], uncommitted: [] }).status).toBe('up to date');
    expect(decide({ health, baseline, commits: ['def feat'], uncommitted: [] }).status).toBe('deploy');
    expect(decide({ health, baseline, commits: [], uncommitted: [' M src/index.ts'] }).status).toBe('deploy');
    expect(decide({ health, baseline: null, commits: [], uncommitted: [] }).status).toBe('deploy');
    expect(decide({ health: null, baseline: null, commits: [], uncommitted: [] }).status).toBe('UNREACHABLE');
  });
});
