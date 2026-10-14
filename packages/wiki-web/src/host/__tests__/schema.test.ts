// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { WikiTypeInfo } from '../../api/client';

vi.mock('@nimbalyst/collab-bundle/trackers-ui', () => ({
  BrowserTrackerSchemaStore: class {},
  parseBuiltinTrackers: () => [],
}));

const { modelJson } = await import('../schema');

const partner = (definition: Record<string, unknown> | null): WikiTypeInfo => ({
  typeId: 'partner',
  displayName: 'Partner',
  displayNamePlural: 'Partners',
  storage: 'table',
  titleField: 'name',
  definition,
  fields: [
    { name: 'name', type: 'string' },
    { name: 'tier', type: 'select' },
    { name: 'description', type: 'text' },
  ],
});

describe('modelJson tableView', () => {
  it('shows the type file\'s own fields as columns when it declares none', () => {
    const model = JSON.parse(modelJson(partner(null)));
    // Without this only role fields render, and the viewer offers no column picker.
    expect(model.tableView.defaultColumns).toEqual(['tier']);
  });

  it('keeps the columns a type file declares', () => {
    const model = JSON.parse(modelJson(partner({ tableView: { defaultColumns: [] } })));
    expect(model.tableView.defaultColumns).toEqual([]);
  });
});
