// @vitest-environment node
/**
 * The local server's Teams tools that do not need a wiki: `openUrl` opens only
 * console pages, and `teamSignIn` answers pending until the device flow is
 * approved, then signedIn, without a second approval on the next call.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { saveCredentials } from '../../cloud/credentials.js';
import { teamTools } from '../teamTools.js';
import type { LocalWikiContext } from '../localTools.js';

const noWiki = { open: async () => Promise.reject(new Error('no wiki')), init: async () => Promise.reject(new Error('no wiki')) } as unknown as LocalWikiContext;
const text = (result: { content: { text: string }[] }) => result.content[0]!.text;

let tmp: string;
const savedEnv = { ...process.env };
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'nim-team-tools-'));
  process.env.NIM_CONFIG_DIR = tmp;
  process.env.NIM_SERVER = 'https://sync.test';
});
afterEach(() => {
  process.env = { ...savedEnv };
  rmSync(tmp, { recursive: true, force: true });
});

function tools(options: Parameters<typeof teamTools>[1] = {}) {
  return new Map(teamTools(noWiki, options).map((tool) => [tool.definition.name, tool]));
}

describe('openUrl', () => {
  it('opens console pages and refuses every other origin', async () => {
    const opened: string[] = [];
    const openUrl = tools({ openUrl: (url) => opened.push(url) }).get('openUrl')!;
    const home = 'https://console.nimbalyst.com/org/o1/project/p1/document/d1';
    expect((await openUrl.call({ url: home })).isError).toBeUndefined();
    for (const url of [
      'http://console.nimbalyst.com/org/o1',
      'https://console.nimbalyst.com.evil.test/org/o1',
      'https://evil.test/?https://console.nimbalyst.com/',
      'https://user@console.nimbalyst.com/org/o1',
      'https://console.nimbalyst.com:8443/org/o1',
      'https://console.nimbalyst.com/org/o1?a=1&calc',
      'file:///etc/passwd',
      'javascript:alert(1)',
      '',
    ]) {
      const result = await openUrl.call({ url });
      expect(result.isError, url).toBe(true);
    }
    expect(opened).toEqual([home]);
  });
});

describe('teamSignIn', () => {
  it('returns the code while pending, signedIn once approved, and needs no new approval after', async () => {
    const opened: string[] = [];
    let approve!: () => void;
    let logins = 0;
    const deviceLogin = (async (server: string, onPrompt: (code: string, uri: string, complete?: string) => void) => {
      logins++;
      onPrompt('ABCD-EFGH', 'https://console.nimbalyst.com/device', 'https://console.nimbalyst.com/device?code=ABCD-EFGH');
      await new Promise<void>((resolve) => (approve = resolve));
      const creds = { accessToken: 'at', refreshToken: 'rt' };
      await saveCredentials(server, creds);
      return creds;
    }) as any;
    const signIn = tools({ openUrl: (url) => opened.push(url), deviceLogin, userInfo: async () => ({ sub: 'u1', email: 'kim@example.com' }), pollWaitMs: 10 }).get('teamSignIn')!;

    const first = JSON.parse(text(await signIn.call({})));
    expect(first).toMatchObject({ state: 'pending', userCode: 'ABCD-EFGH', verificationUrl: 'https://console.nimbalyst.com/device?code=ABCD-EFGH' });
    expect(opened).toEqual(['https://console.nimbalyst.com/device?code=ABCD-EFGH']);
    expect(JSON.parse(text(await signIn.call({})))).toMatchObject({ state: 'pending', userCode: 'ABCD-EFGH' });

    approve();
    expect(JSON.parse(text(await signIn.call({})))).toEqual({ state: 'signedIn', server: 'https://sync.test', email: 'kim@example.com' });
    // Stored where `nim login` keeps it; a later call reuses it.
    expect(JSON.parse(text(await signIn.call({})))).toMatchObject({ state: 'signedIn' });
    expect(logins).toBe(1);
  });
});
