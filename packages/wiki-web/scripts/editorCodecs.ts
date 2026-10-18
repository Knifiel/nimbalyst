/**
 * Editor pages written into team documents, for `nim wiki move-to-team`: the
 * editors' own collaboration codecs (the same `seedFromFile` / `applyFromFile`
 * the desktop share flow runs), applied to a document room's Y.Doc.
 *
 * Bundled into `editor-models.mjs` with the sync client nim opens the room
 * with, so the room's Y.Doc and the codecs share one copy of yjs.
 *
 * Every write records, in the document itself and in the same transaction, a
 * hash of what the page reads as afterwards (`MOVE_RECORD`). A later run
 * updates the page only while it still reads exactly that way; any change a
 * person made since, a deletion included, makes it read otherwise, and the
 * move leaves the page as it is (`edited`), as the markdown import does with
 * `body_edited`. Content, not Yjs client ids, is the test: a deletion adds no
 * client to a state vector, and client ids stay Yjs's own random ones.
 */
import { createHash } from 'node:crypto';
import * as Y from 'yjs';

/** The move's record in a document it wrote: `baseline`, the sha256 of the page's file text after that write. */
export const MOVE_RECORD = 'nimbalystWikiMove';

/** The part of an extension's CollabCodec the move uses. */
export interface MoveCodec {
  documentType: string;
  isEmpty(doc: Y.Doc): boolean;
  seedFromFile(doc: Y.Doc, source: string): void;
  applyFromFile(doc: Y.Doc, source: string): void;
  exportToFile(doc: Y.Doc): string | Uint8Array;
}

/**
 * `seeded`: the room was empty and never written. `applied`: updated in place.
 * `unchanged`: it already reads as the file. `edited`: someone else changed or
 * filled it since the move last wrote it; not written.
 */
export type EditorDocWrite = 'seeded' | 'applied' | 'unchanged' | 'edited';

export interface EditorCodecs {
  documentTypes: string[];
  /**
   * Makes `doc` read as `fileText`, unless someone else has changed it. Call
   * it only on a fully synced room: `roomHadState` is the server's word on
   * whether the room held anything, so an empty-looking room the server says
   * is not empty is never seeded over.
   */
  writeDoc(documentType: string, doc: Y.Doc, fileText: string, options: { roomHadState: boolean }): EditorDocWrite;
  /** The document's content in the editor's file format. */
  exportDoc(documentType: string, doc: Y.Doc): string;
}

function asText(content: string | Uint8Array): string {
  return typeof content === 'string' ? content : new TextDecoder().decode(content);
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export function createEditorCodecs(codecs: readonly MoveCodec[]): EditorCodecs {
  const byType = new Map(codecs.map((codec) => [codec.documentType, codec]));
  const codecFor = (documentType: string): MoveCodec => {
    const codec = byType.get(documentType);
    if (!codec) throw new Error(`No editor codec for document type ${documentType}`);
    return codec;
  };
  return {
    documentTypes: [...byType.keys()],
    writeDoc(documentType, doc, fileText, { roomHadState }) {
      const codec = codecFor(documentType);
      const record = doc.getMap<string>(MOVE_RECORD);
      const baseline = record.get('baseline');
      const write = (change: () => void) =>
        doc.transact(() => {
          change();
          record.set('baseline', sha256(asText(codec.exportToFile(doc))));
        });
      if (baseline === undefined) {
        // Never written by the move: only a room nobody has put anything in is ours to fill.
        if (roomHadState || !codec.isEmpty(doc)) return asText(codec.exportToFile(doc)) === fileText ? 'unchanged' : 'edited';
        write(() => codec.seedFromFile(doc, fileText));
        return 'seeded';
      }
      const current = asText(codec.exportToFile(doc));
      if (sha256(current) !== baseline) return 'edited';
      if (current === fileText) return 'unchanged';
      write(() => codec.applyFromFile(doc, fileText));
      return 'applied';
    },
    exportDoc(documentType, doc) {
      return asText(codecFor(documentType).exportToFile(doc));
    },
  };
}
