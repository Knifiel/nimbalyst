// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pageImageResolver, pageUploadAsset } from '../pageAssets';

afterEach(() => vi.unstubAllGlobals());

describe('page files in the browser view', () => {
  it('stores a pasted image and a dropped file in the page and writes relative links, never data URLs', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const name = new URL(url, 'http://wiki.test').searchParams.get('name')!;
      return new Response(JSON.stringify({ path: `Plan/.assets/${name}`, link: `Plan/.assets/${encodeURIComponent(name)}` }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const upload = pageUploadAsset('page 1');

    const image = await upload(new File([new Uint8Array([1])], '', { type: 'image/png' }));
    expect(image).toEqual({ kind: 'image', src: 'Plan/.assets/image.png', altText: 'image.png' });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/pages/page%201/attachments?name=image.png');

    const heic = await upload(new File([new Uint8Array([1])], 'IMG 1.heic', { type: 'image/heic' }));
    expect(heic).toEqual({ kind: 'file', src: 'Plan/.assets/IMG%201.heic', name: 'IMG 1.heic' });
  });

  it('says why an upload was refused', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'too-large', message: 'Files over 25 MB cannot be attached here' } }), { status: 413 })));
    await expect(pageUploadAsset('p')(new File(['x'], 'big.bin'))).rejects.toThrow('Files over 25 MB cannot be attached here');
  });

  it('serves relative image paths from the page and leaves URLs to the editor', async () => {
    const resolve = pageImageResolver('p');
    expect(await resolve('Plan/.assets/shot%20one.png')).toBe('/api/pages/p/file?path=Plan%2F.assets%2Fshot%20one.png');
    expect(await resolve('./Plan/.assets/a b.png')).toBe('/api/pages/p/file?path=Plan%2F.assets%2Fa%20b.png');
    expect(await resolve('../Other/.assets/x.png?v=2')).toBe('/api/pages/p/file?path=..%2FOther%2F.assets%2Fx.png');
    for (const src of ['https://x.test/a.png', 'data:image/png;base64,AA', 'blob:abc', 'collab-asset://a', '/abs.png', '#x', '']) {
      expect(await resolve(src)).toBeNull();
    }
  });
});
