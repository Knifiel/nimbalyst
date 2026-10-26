// @vitest-environment jsdom
import React, { useState } from 'react';
import { File as NodeFile } from 'node:buffer';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AIInput } from '../AIInput';

vi.mock('../AIInputControls', () => ({ AIInputControls: () => null }));
vi.mock('../../../help', () => ({ HelpTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({ MaterialSymbol: () => null }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup(save?: Promise<unknown>) {
  let resolveClipboard!: (image: { mimeType: string; data: Uint8Array } | null) => void;
  const clipboard = new Promise<{ mimeType: string; data: Uint8Array } | null>(resolve => { resolveClipboard = resolve; });
  const onAttachmentAdd = vi.fn();
  const onSend = vi.fn();
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'attachment:validate') return { valid: true };
    if (channel === 'attachment:save') return save ?? { success: true, attachment: { id: 'pasted' } };
    return {};
  });
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    readWindowsClipboardImage: vi.fn(() => clipboard), invoke,
  } });
  // jsdom's File does not implement arrayBuffer.
  vi.stubGlobal('File', NodeFile);
  function Harness({ sessionId = 'clipboard-test' }: { sessionId?: string }) {
    const [value, setValue] = useState('original');
    return <AIInput value={value} onChange={setValue} onSend={onSend}
      sessionId={sessionId} remoteSession onAttachmentAdd={onAttachmentAdd} />;
  }
  const store = createStore();
  const view = render(<Provider store={store}><Harness /></Provider>);
  const input = screen.getByRole('textbox') as HTMLTextAreaElement;
  fireEvent.paste(input, { clipboardData: { items: [], files: [], getData: () => '' } });
  return { input, onAttachmentAdd, onSend, invoke, resolveClipboard, unmount: view.unmount,
    switchSession: () => view.rerender(<Provider store={store}><Harness sessionId="other-session" /></Provider>),
  };
}

describe('Windows clipboard image paste', () => {
  it('cancels an image read when the paste is undone before the clipboard responds', async () => {
    const { input, onAttachmentAdd, invoke, resolveClipboard } = setup();
    fireEvent.keyDown(input, { key: 'z', ctrlKey: true });
    await act(async () => { resolveClipboard({ mimeType: 'image/png', data: new Uint8Array(8) }); });
    expect(onAttachmentAdd).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith('attachment:save', expect.anything());
    expect(input.value).toBe('original');
  });

  it('preserves edits made while waiting and blocks sending until the image is attached', async () => {
    const { input, onAttachmentAdd, onSend, resolveClipboard } = setup();
    fireEvent.change(input, { target: { value: 'edited while waiting' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    await act(async () => { resolveClipboard({ mimeType: 'image/png', data: new Uint8Array(8) }); });
    expect(onAttachmentAdd).toHaveBeenCalledTimes(1);
    expect(input.value).toMatch(/^edited while waiting @pasted-image-.*\.png $/);
  });

  it('releases the pending state when the clipboard has no image', async () => {
    const { input, onSend, resolveClipboard } = setup();
    await act(async () => { resolveClipboard(null); });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('original');
  });

  it.each(['switchSession', 'unmount'] as const)('discards the clipboard result after %s', async action => {
    const result = setup();
    result[action]();
    await act(async () => { result.resolveClipboard({ mimeType: 'image/png', data: new Uint8Array(8) }); });
    expect(result.onAttachmentAdd).not.toHaveBeenCalled();
    expect(result.invoke).not.toHaveBeenCalledWith('attachment:save', expect.anything());
  });

  it('preserves edits made during attachment storage as well as the clipboard read', async () => {
    let finishSave!: (result: unknown) => void;
    const save = new Promise(resolve => { finishSave = resolve; });
    const { input, resolveClipboard, onAttachmentAdd } = setup(save);
    await act(async () => { resolveClipboard({ mimeType: 'image/png', data: new Uint8Array(8) }); });
    fireEvent.change(input, { target: { value: 'edited during save' } });
    await act(async () => { finishSave({ success: true, attachment: { id: 'pasted' } }); });
    expect(onAttachmentAdd).toHaveBeenCalledTimes(1);
    expect(input.value).toMatch(/^edited during save @pasted-image-.*\.png $/);
  });
});
