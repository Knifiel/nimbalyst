// @vitest-environment node
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { CsvCollabContentAdapter } from '@nimbalyst/extension-csv-spreadsheet/collab-adapter';
import { createEditorCodecs, type MoveCodec } from '../editorCodecs';

const codecs = createEditorCodecs([CsvCollabContentAdapter as unknown as MoveCodec]);
const csv = CsvCollabContentAdapter as unknown as MoveCodec;
const synced = { roomHadState: true };

/** A room as a new connection sees it: everything written so far, synced into a fresh doc. */
function reopen(room: Y.Doc): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(room));
  return doc;
}

function merge(into: Y.Doc, from: Y.Doc): void {
  Y.applyUpdate(into, Y.encodeStateAsUpdate(from));
}

function seeded(text: string): Y.Doc {
  const doc = new Y.Doc();
  expect(codecs.writeDoc('csv', doc, text, { roomHadState: false })).toBe('seeded');
  return doc;
}

/** A teammate's change, made in their own client and merged into the room. */
function teammateWrites(room: Y.Doc, text: string): void {
  const teammate = reopen(room);
  csv.applyFromFile(teammate, text);
  merge(room, teammate);
}

describe('editor codecs for the wiki move', () => {
  it('seeds an empty room, leaves a matching one alone, and updates its own write in place on a re-run', () => {
    const room = seeded('name,role\nAda,eng\n');
    expect(codecs.exportDoc('csv', room)).toBe('name,role\nAda,eng\n');

    expect(codecs.writeDoc('csv', reopen(room), 'name,role\nAda,eng\n', synced)).toBe('unchanged');

    const rerun = reopen(room);
    expect(codecs.writeDoc('csv', rerun, 'name,role\nAda,eng\nGrace,ops\n', synced)).toBe('applied');
    // Applied on top of the room, not beside it: merging back doubles nothing.
    merge(room, rerun);
    expect(codecs.exportDoc('csv', room)).toBe('name,role\nAda,eng\nGrace,ops\n');
    // And the next run still recognises the page as its own.
    expect(codecs.writeDoc('csv', reopen(room), 'name,role\nGrace,ops\n', synced)).toBe('applied');
  });

  it('leaves a page someone changed in the team as it is, a deletion or a cleared page included', () => {
    for (const teammateText of ['name,role\nAda,lead\nGrace,ops\n', 'name,role\nAda,eng\n', '']) {
      const room = seeded('name,role\nAda,eng\nGrace,ops\n');
      teammateWrites(room, teammateText);
      const rerun = reopen(room);
      expect(codecs.writeDoc('csv', rerun, 'name,role\nAda,eng\nGrace,ops\nLin,pm\n', synced)).toBe('edited');
      expect(codecs.exportDoc('csv', rerun)).toBe(codecs.exportDoc('csv', room));
    }
  });

  it('never seeds a room it did not write: one with content, or one the server says is not empty', () => {
    const shared = new Y.Doc();
    csv.seedFromFile(shared, 'a\n1\n');
    expect(codecs.writeDoc('csv', reopen(shared), 'a\n2\n', synced)).toBe('edited');
    expect(codecs.writeDoc('csv', reopen(shared), 'a\n1\n', synced)).toBe('unchanged');
    // Looks empty locally (say, a snapshot it could not read), but the server holds state.
    expect(codecs.writeDoc('csv', new Y.Doc(), 'a\n2\n', { roomHadState: true })).toBe('edited');
  });

  it('two moves of the same page at once still converge, and the next run treats the page as changed', () => {
    const room = seeded('a\n1\n');
    const first = reopen(room);
    const second = reopen(room);
    expect(codecs.writeDoc('csv', first, 'a\nAAAA\n', synced)).toBe('applied');
    expect(codecs.writeDoc('csv', second, 'a\nBBBB\n', synced)).toBe('applied');
    merge(first, second);
    merge(second, first);
    expect(codecs.exportDoc('csv', first)).toBe(codecs.exportDoc('csv', second));
    merge(room, first);
    expect(codecs.writeDoc('csv', reopen(room), 'a\nCCCC\n', synced)).toBe('edited');
  });

  it('names a document type it has no codec for', () => {
    expect(() => codecs.writeDoc('mindmap', new Y.Doc(), '{}', synced)).toThrow(/mindmap/);
  });
});
