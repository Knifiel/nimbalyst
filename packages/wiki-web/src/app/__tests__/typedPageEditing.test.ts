// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { typedPageEditing } from '../typedPageEditing';

describe('typedPageEditing', () => {
  it('gives a table row no way to rename, edit or archive, and leaves pages editable', () => {
    const handlers = { update: vi.fn(async () => {}), archive: vi.fn(), fail: vi.fn() };
    const row = typedPageEditing('table', handlers);
    expect(row.editable).toBe(false);
    expect(row.onArchive).toBeUndefined();
    row.onRename('Renamed');
    row.onUpdateField({ name: 'tier' } as never, 'gold');
    expect(handlers.update).not.toHaveBeenCalled();

    const page = typedPageEditing('pages', handlers);
    expect(page.editable).toBe(true);
    page.onRename('Renamed');
    page.onUpdateField({ name: 'tier' } as never, 'gold');
    page.onArchive!();
    expect(handlers.update.mock.calls).toEqual([[{ title: 'Renamed' }], [{ tier: 'gold' }]]);
    expect(handlers.archive).toHaveBeenCalledOnce();
  });
});
