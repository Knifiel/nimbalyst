// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { LocalPage } from '@nimbalyst/local-wiki';
import { resolveWikiLink } from '../links';
import { pageLinkOptions } from '../pageLinks';

const page = (id: string, path: string, type: string | null = null, trashedAt: number | null = null) =>
  ({ id, path, dir: path.replace(/\.md$/, ''), type, trashedAt }) as LocalPage;

const pages = [
  page('personas', 'Personas.md'),
  page('cmo', 'Personas/CMO.md', 'persona'),
  page('pm', 'Personas/Product manager.md', 'persona'),
  page('arch', 'Architecture.md'),
  page('old', 'Old.md', null, 1000),
];

describe('resolveWikiLink', () => {
  it('resolves a link relative to the linking page, to a page or a typed page', () => {
    expect(resolveWikiLink(pages, 'Personas.md', 'Personas/CMO.md')).toEqual({ kind: 'item', id: 'cmo' });
    expect(resolveWikiLink(pages, 'Personas.md', 'Personas/Product%20manager.md')).toEqual({ kind: 'item', id: 'pm' });
    expect(resolveWikiLink(pages, 'Personas/CMO.md', '../Architecture.md#3-system-context')).toEqual({ kind: 'page', id: 'arch' });
    expect(resolveWikiLink(pages, 'Architecture.md', 'Personas/')).toEqual({ kind: 'page', id: 'personas' });
  });

  it('reports a file outside the wiki, or a trashed page, instead of opening something else', () => {
    expect(resolveWikiLink(pages, 'Personas.md', '../research/Interview%20Guide.md')).toEqual({ kind: 'outside', path: '../research/Interview Guide.md' });
    expect(resolveWikiLink(pages, 'Architecture.md', 'Old.md')).toEqual({ kind: 'outside', path: 'Old.md' });
  });
});

describe('pageLinkOptions', () => {
  const full = (base: LocalPage, documentType = 'markdown') => ({ ...base, title: base.id, documentType, malformed: false }) as LocalPage;
  const all = [...pages.map((p) => full(p)), full({ ...page('folder', 'x'), path: null, dir: 'Personas/Team' } as LocalPage)];

  it('writes links the @ picker inserts relative to the linking page, with the id, and resolving back to the same page', () => {
    const fromCmo = pageLinkOptions(all, 'cmo');
    expect(fromCmo.map((o) => o.id)).toEqual(['personas', 'pm', 'arch', 'folder']);
    expect(fromCmo.find((o) => o.id === 'pm')).toMatchObject({ href: 'Product%20manager.md', linkTitle: 'id=pm', folderPath: 'Personas' });
    expect(fromCmo.find((o) => o.id === 'arch')!.href).toBe('../Architecture.md');
    expect(fromCmo.find((o) => o.id === 'folder')!.href).toBe('Team/');
    for (const option of fromCmo.filter((o) => o.id !== 'folder')) {
      expect(resolveWikiLink(pages, 'Personas/CMO.md', option.href)).toMatchObject({ id: option.id });
    }
    expect(pageLinkOptions(all, 'arch').find((o) => o.id === 'cmo')!.href).toBe('Personas/CMO.md');
  });
});
