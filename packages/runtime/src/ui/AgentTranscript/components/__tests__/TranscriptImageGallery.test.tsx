import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { TranscriptViewMessage } from '../../../../ai/server/transcript/TranscriptProjector';
import { TranscriptImageGalleryProvider } from '../TranscriptImageGallery';
import { collectTranscriptImages } from '../../utils/transcriptImages';
import { MessageSegment } from '../MessageSegment';
import { EditorScreenshotWidget } from '../CustomToolWidgets/EditorScreenshotWidget';

vi.mock('posthog-js/react', () => ({
  usePostHog: () => ({ capture: vi.fn() }),
}));

const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

let nextId = 1;

function makeMessage(overrides: Partial<TranscriptViewMessage>): TranscriptViewMessage {
  const id = nextId++;
  return { id, sequence: id, createdAt: new Date(), type: 'assistant_message', subagentId: null, ...overrides };
}

function makeTool(toolName: string, args: Record<string, unknown>, result: unknown, overrides: Partial<TranscriptViewMessage> = {}) {
  return makeMessage({
    type: 'tool_call',
    toolCall: {
      toolName,
      toolDisplayName: toolName,
      status: 'completed',
      description: null,
      arguments: args,
      targetFilePath: null,
      mcpServer: null,
      mcpTool: null,
      providerToolCallId: `tool-${nextId}`,
      progress: [],
      result: typeof result === 'string' ? result : JSON.stringify(result),
    },
    ...overrides,
  });
}

function attachment(id: string, filename: string) {
  return { id, filename, filepath: `data:image/png;base64,${PIXEL}`, mimeType: 'image/png', size: 10, type: 'image' as const, addedAt: 0 };
}

const screenshotResult = [{ type: 'image', source: { type: 'base64', data: PIXEL, media_type: 'image/png' } }];

describe('collectTranscriptImages', () => {
  it('lists every image in transcript order, including sub-agent tool calls, and skips charts and failed screenshots', () => {
    const user = makeMessage({ type: 'user_message', attachments: [attachment('a1', 'one.png'), { ...attachment('pdf', 'doc.pdf'), type: 'pdf' as const }] });
    const shot = makeTool('mcp__nimbalyst-mcp__capture_editor_screenshot', { file_path: '/w/a.mockup.html' }, screenshotResult);
    const failedShot = makeTool('capture_editor_screenshot', { file_path: '/w/b.mockup.html' }, 'boom', { isError: true });
    const display = makeTool('mcp__nimbalyst__display_to_user', { items: [
      { description: 'Chart', chart: { chartType: 'bar', data: [], xAxisKey: 'x', yAxisKey: 'y' } },
      { description: 'Shot B', image: { path: '/tmp/b.png' } },
    ] }, 'ok');
    const childShot = makeTool('capture_editor_screenshot', { file_path: '/w/child.mockup.html' }, screenshotResult);
    const agent = makeTool('Task', {}, 'done', { subagent: { childEvents: [childShot] } as unknown as TranscriptViewMessage['subagent'] });

    const images = collectTranscriptImages([user, shot, failedShot, display, agent]);

    expect(images.map(image => image.label)).toEqual(['one.png', 'a.mockup.html', 'Shot B', 'child.mockup.html']);
    expect(new Set(images.map(image => image.key)).size).toBe(4);
  });
});

describe('TranscriptImageGalleryProvider', () => {
  it('steps through every transcript image with the arrow keys after one is enlarged', async () => {
    const user = makeMessage({ type: 'user_message', attachments: [attachment('a1', 'first.png'), attachment('a2', 'second.png')] });
    const shot = makeTool('capture_editor_screenshot', { file_path: '/w/third.mockup.html' }, screenshotResult);

    render(
      <TranscriptImageGalleryProvider messages={[user, shot]}>
        <MessageSegment message={user} isUser showToolCalls={false} showThinking={false} expandedTools={new Set()} onToggleToolExpand={() => {}} />
        <EditorScreenshotWidget message={shot} isExpanded={false} onToggle={() => {}} sessionId="s" />
      </TranscriptImageGalleryProvider>
    );

    fireEvent.click(screen.getByAltText('second.png'));
    const position = () => screen.getByTestId('transcript-image-position').textContent;
    expect(position()).toBe('2 / 3');

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(position()).toBe('3 / 3');
    await waitFor(() => expect(screen.getByTestId('zoomable-image').getAttribute('alt')).toBe('third.mockup.html'));

    // The last image stays put rather than wrapping to the first.
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(position()).toBe('3 / 3');

    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(position()).toBe('1 / 3');
    expect(screen.getByTestId('zoomable-image').getAttribute('alt')).toBe('first.png');
  });
});
