// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  executeExtensionTool,
  registerExtensionTools,
  setEnsureEditorCallback,
  unregisterExtensionTools,
} from '@nimbalyst/runtime/extensions/ExtensionAIToolsBridge';
import type { LoadedExtension } from '@nimbalyst/runtime/extensions/types';
import { gitLogTool } from '../gitLogTool';

vi.mock('../../utils/gitOperations', () => ({
  getGitLog: vi.fn(async () => [{ hash: 'abc123', message: 'init', author: 'a', date: 'd' }]),
}));

const manifest = { id: 'com.nimbalyst.developer', name: 'Developer Tools', version: '0.0.0', main: 'index.js' };

function makeExtension(): LoadedExtension {
  return {
    manifest,
    module: { aiTools: [gitLogTool] },
    context: {
      manifest,
      extensionPath: '/tmp/developer',
      services: {} as LoadedExtension['context']['services'],
      subscriptions: [],
    },
    enabled: true,
    dispose: async () => {},
  };
}

describe('git_log', () => {
  afterEach(() => {
    unregisterExtensionTools('com.nimbalyst.developer');
    setEnsureEditorCallback(async () => {}, () => {});
  });

  // #382: the agent passes the workspace folder as filePath. Mounting an editor
  // on a folder fails, so git_log must never ask for one.
  it('returns commits for a folder filePath without mounting an editor', async () => {
    let ensureCalls = 0;
    setEnsureEditorCallback(
      async (filePath) => {
        ensureCalls++;
        throw new Error(`File has no extension: ${filePath}`);
      },
      () => {}
    );
    registerExtensionTools(makeExtension());

    const result = await executeExtensionTool(
      'developer.git_log',
      { filePath: '/workspace' },
      { workspacePath: '/workspace' }
    );

    expect(ensureCalls).toBe(0);
    expect(result.success).toBe(true);
  });
});
