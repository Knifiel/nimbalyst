// @vitest-environment node
/**
 * `listMarks`: decision and open-question marks across the local wiki, read
 * with the app's own parser so a mark means the same here as in the editor.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
// The app's parser, from source: what the editor and the desktop marks index use.
import { findPageMarks } from '../../../../runtime/src/core/pageMarkSyntax';
import { initLocalWiki, type OpenedWiki } from '../open.js';
import { listMarks } from '../marks.js';

const dirs: string[] = [];
const wikis: OpenedWiki[] = [];
afterEach(() => {
  for (const opened of wikis.splice(0)) opened.wiki.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const STORAGE_BODY = [
  'Intro.',
  '',
  '[Storage lives in [Flagship](nimbalyst://X).]{decided by="Greg Hinkle" email=greg@example.com on=2026-09-30 over="our own engine"}',
  'Then [Pricing is *unknown*.]{open by=Spike} and [Use `nim` for **scripts**.]{decided by="A \\"B\\" C" on=2026-10-01}',
  'Not marks: `[in code]{open}` and ![image]{open} and \\[escaped]{open}.',
  '',
  '```',
  '[In a fence.]{decided}',
  '```',
  '',
  '[Is latency fine?]{open}',
  '',
].join('\n');

async function wiki(): Promise<OpenedWiki> {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'nim-marks-')));
  dirs.push(root);
  const opened = await initLocalWiki(root);
  wikis.push(opened);
  writeFileSync(path.join(opened.dir, 'Storage.md'), `---\nid: page-storage\n---\n\n${STORAGE_BODY}`);
  writeFileSync(path.join(opened.dir, 'Billing.md'), '---\nid: page-billing\n---\n\n[Bill monthly.]{decided by=Dana email=dana@example.com on=2026-08-01 over="annual only"}\n');
  await opened.wiki.rescan();
  return opened;
}

describe('listMarks', () => {
  it('finds the marks the app parser finds, on the same lines', async () => {
    const opened = await wiki();
    const result = await listMarks(opened, { limit: 50 });
    const storage = result.marks.filter((mark) => mark.pageId === 'page-storage');
    const body = (await opened.wiki.readBody('page-storage')).markdown;
    const app = findPageMarks(body);
    expect(app).toHaveLength(4);
    expect(storage).toEqual(
      app.map((mark) => ({
        pageId: 'page-storage',
        title: 'Storage',
        line: mark.line,
        kind: mark.kind,
        ...(mark.by ? { by: mark.by } : {}),
        ...(mark.email ? { email: mark.email } : {}),
        ...(mark.on ? { on: mark.on } : {}),
        ...(mark.over ? { over: mark.over } : {}),
        text: mark.plainText,
      })),
    );
    expect(storage.map((mark) => mark.text)).toEqual(['Storage lives in Flagship.', 'Pricing is unknown.', 'Use nim for scripts.', 'Is latency fine?']);
    expect(storage[2].by).toBe('A "B" C');
    expect(result.total).toBe(5);
  });

  it('filters by kind, person and words, and caps the list', async () => {
    const opened = await wiki();
    expect((await listMarks(opened, { kind: 'open' })).marks.map((mark) => mark.text)).toEqual(['Pricing is unknown.', 'Is latency fine?']);
    // `by` matches the name or the email, ignoring case.
    expect((await listMarks(opened, { by: 'GREG' })).marks.map((mark) => mark.pageId)).toEqual(['page-storage']);
    expect((await listMarks(opened, { by: 'dana@example' })).marks.map((mark) => mark.text)).toEqual(['Bill monthly.']);
    // `query` words all have to appear in the sentence, what it was chosen over, or the page title.
    expect((await listMarks(opened, { query: 'annual billing' })).marks.map((mark) => mark.text)).toEqual(['Bill monthly.']);
    expect((await listMarks(opened, { query: 'storage engine' })).marks.map((mark) => mark.text)).toEqual(['Storage lives in Flagship.']);
    const capped = await listMarks(opened, { limit: 2 });
    expect(capped.total).toBe(5);
    expect(capped.marks).toHaveLength(2);
  });
});
