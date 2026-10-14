/**
 * Module-level converter for absolute filesystem paths into URLs the renderer
 * can actually load.
 *
 * Background: the Electron main BrowserWindow runs with `webSecurity: true`
 * (Issue #146), which blocks `<img src="file://...">`. Electron registers a
 * `nim-asset://` custom protocol that is treated as same-origin; runtime code
 * must route local-file image rendering through it.
 *
 * Runtime cannot import from the Electron package, so the Electron renderer
 * registers `nimAssetUrl` here at startup. Non-Electron consumers fall back to
 * `file://`. The iOS transcript WKWebView cannot read desktop paths at all, so
 * anything it must show (e.g. display_to_user images) has to arrive as inline
 * bytes on the sync path instead.
 */

let registeredConverter: (absolutePath: string) => string = (absolutePath) =>
  `file://${absolutePath}`;

export function registerLocalAssetUrlConverter(
  converter: (absolutePath: string) => string,
): void {
  registeredConverter = converter;
}

/**
 * Convert an absolute filesystem path to a URL the renderer can load.
 * Use this anywhere runtime code would otherwise hardcode `file://${path}`.
 */
export function localAssetUrl(absolutePath: string): string {
  return registeredConverter(absolutePath);
}
