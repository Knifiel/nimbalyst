// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const extensionSettings: Record<string, { enabled?: boolean }> = {};
const pluginEnabled: Record<string, boolean | undefined> = {};

vi.mock('../../../utils/store', () => ({
  getExtensionEnabled: (id: string, defaultEnabled?: boolean) =>
    extensionSettings[id]?.enabled ?? defaultEnabled !== false,
  getClaudePluginEnabled: (id: string) => pluginEnabled[id],
}));

import { isWikiSkillAvailable } from '../wikiSkillAvailability';

describe('isWikiSkillAvailable', () => {
  beforeEach(() => {
    for (const key of Object.keys(extensionSettings)) delete extensionSettings[key];
    for (const key of Object.keys(pluginEnabled)) delete pluginEnabled[key];
  });

  it('is on for a user who never touched the Wiki extension, and respects an explicit off', () => {
    expect(isWikiSkillAvailable()).toBe(true);

    extensionSettings['com.nimbalyst.knowledge'] = { enabled: false };
    expect(isWikiSkillAvailable()).toBe(false);

    extensionSettings['com.nimbalyst.knowledge'] = { enabled: true };
    pluginEnabled['com.nimbalyst.knowledge'] = false;
    expect(isWikiSkillAvailable()).toBe(false);
  });
});
