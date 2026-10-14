/**
 * Attachments: files dropped into a page, kept in `.assets/` inside the page's
 * child folder so moves and trash carry them with the page. See FORMAT.md
 * "Attachments".
 */
import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileStemForTitle, nameKey } from './names.js';
import { rewriteFileLinks } from './links.js';
import { relJoin } from './fsutil.js';

export const ATTACHMENTS_DIR = '.assets';

/** A safe file name for an attachment: the title rules for the stem, a plain extension. */
export function attachmentFileName(name: string): string {
  const base = path.posix.basename(name.replace(/\\/g, '/'));
  const dot = base.lastIndexOf('.');
  const rawExt = dot > 0 ? base.slice(dot + 1) : '';
  const ext = /^[A-Za-z0-9]{1,16}$/.test(rawExt) ? rawExt : '';
  const stem = fileStemForTitle(ext ? base.slice(0, dot) : base);
  return ext ? `${stem}.${ext}` : stem;
}

/** `name`, else `name (2).ext`, `name (3).ext`, ... whichever key is free. */
export function uniqueAttachmentName(name: string, occupied: ReadonlySet<string>): string {
  if (!occupied.has(nameKey(name))) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!occupied.has(nameKey(candidate))) return candidate;
  }
}

/**
 * Writes `bytes` as an attachment in `assetsAbs`. A file of the same name and
 * content is reused; a different file of that name gets a ` (n)` suffix.
 * Returns the name written.
 */
export async function writeAttachment(assetsAbs: string, fileName: string, bytes: Uint8Array, existing: readonly string[]): Promise<string> {
  const wanted = attachmentFileName(fileName);
  const occupied = new Set<string>();
  for (const entry of existing) {
    if (nameKey(entry) === nameKey(wanted) || nameKey(entry).startsWith(nameKey(wanted.replace(/\.[^.]*$/, '')) + ' (')) {
      try {
        if (Buffer.from(await readFile(path.join(assetsAbs, entry))).equals(Buffer.from(bytes))) return entry;
      } catch {
        // unreadable: treat as taken
      }
    }
    occupied.add(nameKey(entry));
  }
  const name = uniqueAttachmentName(wanted, occupied);
  await writeFile(path.join(assetsAbs, name), bytes, { flag: 'wx' });
  return name;
}

/**
 * After a page moves or is renamed, repoints the page's own links into its old
 * child folder (attachments, images) at the new one. `oldPrefix`/`newPrefix`
 * are the child folder relative to the folder the page's links are written in.
 */
export function rebaseChildFolderLinks(body: string, oldPrefix: string, newPrefix: string): string {
  if (oldPrefix === newPrefix) return body;
  const from = nameKey(oldPrefix) + '/';
  return rewriteFileLinks(body, (linkPath) => {
    const normalized = path.posix.normalize(linkPath);
    if (!nameKey(normalized).startsWith(from)) return null;
    return relJoin(newPrefix, normalized.slice(from.length));
  });
}
