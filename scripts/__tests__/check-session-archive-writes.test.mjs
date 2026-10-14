import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { checkArchiveWrites, findArchiveWrites, isArchiveHelper } from '../check-session-archive-writes.mjs';

test('recognizes the helper from a Windows-style path', () => {
  const root = 'C:\\repo';
  const helper = path.win32.join(root, 'packages', 'electron', 'src', 'renderer', 'utils', 'saveSessionArchived.ts');
  const other = path.win32.join(root, 'packages', 'electron', 'src', 'renderer', 'utils', 'other.ts');
  assert.equal(isArchiveHelper(helper, root, path.win32), true);
  assert.equal(isArchiveHelper(other, root, path.win32), false);
});

test('flags direct isArchived writes and ignores comments, strings, and other calls', () => {
  const flagged = [
    `window.electronAPI.invoke('sessions:update-metadata', id, { isArchived: true });`,
    `window.electronAPI.invoke('sessions:update-metadata', id, { isArchived });`,
    `electronAPI.invoke("sessions:update-metadata", id, { name: 'x', isArchived: false });`,
  ].join('\n');
  assert.deepEqual(findArchiveWrites(flagged, 'a.ts').map(hit => hit.line), [1, 2, 3]);
  const clean = [
    `// window.electronAPI.invoke('sessions:update-metadata', id, { isArchived: true });`,
    `const s = "invoke('sessions:update-metadata', id, { isArchived: true })";`,
    `invoke('sessions:update-metadata', id, { mode: 'agent' });`,
    `invoke('sessions:other', id, { isArchived: true });`,
  ].join('\n');
  assert.deepEqual(findArchiveWrites(clean, 'b.tsx'), []);
});

test('no renderer code writes isArchived directly', () => {
  assert.deepEqual(checkArchiveWrites(), []);
});
