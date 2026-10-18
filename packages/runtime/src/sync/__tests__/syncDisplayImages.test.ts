// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';

import { inlineDisplayImagesForSync, setSyncLocalImageLoader } from '../syncDisplayImages';

afterEach(() => setSyncLocalImageLoader(null));

function claudeDisplayRow(paths: string[]): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'toolu_display',
        name: 'mcp__nimbalyst__display_to_user',
        input: { items: paths.map((p) => ({ description: p, image: { path: p } })) },
      }],
    },
  });
}

describe('inlineDisplayImagesForSync', () => {
  it('attaches image bytes to display_to_user items so the phone does not need the desktop path', async () => {
    setSyncLocalImageLoader(async (p) => ({ data: `bytes-of-${p}`, mimeType: 'image/jpeg' }));

    const out = JSON.parse(await inlineDisplayImagesForSync(claudeDisplayRow(['/Users/me/a.png'])));

    expect(out.message.content[0].input.items[0].image).toEqual({
      path: '/Users/me/a.png',
      data: 'bytes-of-/Users/me/a.png',
      mimeType: 'image/jpeg',
    });
  });

  it('covers Codex mcpToolCall rows and leaves items path-only once the row limit is reached', async () => {
    const big = 'x'.repeat(200 * 1024);
    setSyncLocalImageLoader(async () => ({ data: big, mimeType: 'image/jpeg' }));
    const row = JSON.stringify({
      method: 'item/started',
      params: { item: {
        type: 'mcpToolCall', id: 'c1', server: 'nimbalyst', tool: 'display_to_user',
        arguments: { items: [
          { description: 'a', image: { path: '/a.png' } },
          { description: 'b', image: { path: '/b.png' } },
        ] },
      } },
    });

    const items = JSON.parse(await inlineDisplayImagesForSync(row)).params.item.arguments.items;

    expect(items[0].image.data).toBe(big);
    expect(items[1].image).toEqual({ path: '/b.png' });
  });
});
