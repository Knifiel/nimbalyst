// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { teamTypesAreNotSyncing } from '../teamTypesSyncState';

const WS = '/ws/demo';

describe('teamTypesAreNotSyncing', () => {
  it('reports a workspace with team types whose sync has no engine or was refused', () => {
    expect(teamTypesAreNotSyncing({ workspacePath: WS, status: 'disconnected', projectId: null }, WS, true)).toBe(true);
    expect(teamTypesAreNotSyncing({ workspacePath: WS, status: 'error', projectId: 'org' }, WS, true)).toBe(true);
  });

  it('stays quiet while connecting, once connected, with no team types, or for another workspace', () => {
    expect(teamTypesAreNotSyncing({ workspacePath: WS, status: 'connecting', projectId: 'org' }, WS, true)).toBe(false);
    expect(teamTypesAreNotSyncing({ workspacePath: WS, status: 'connected', projectId: 'org' }, WS, true)).toBe(false);
    expect(teamTypesAreNotSyncing({ workspacePath: WS, status: 'disconnected', projectId: null }, WS, false)).toBe(false);
    expect(teamTypesAreNotSyncing({ workspacePath: '/ws/other', status: 'disconnected', projectId: null }, WS, true)).toBe(false);
    expect(teamTypesAreNotSyncing(null, WS, true)).toBe(false);
  });
});
