/**
 * Browser host surface for extension imports externalized as
 * `@nimbalyst/runtime`.
 *
 * A member belongs here only if the browser answer differs from the desktop
 * one, or if the collab bundle does not already own a compiled copy. Anything
 * the bundle exports should be aliased to that subpath instead -- see the
 * `resolve.alias` comment in the web console's `vite.config.ts` for why a second compiled copy of
 * a module with a module-level registry is a silent failure.
 *
 * `MaterialSymbol` is neither: it is a stateless icon component that the collab
 * bundle does not export, so re-exporting the real one from the runtime source is
 * the honest answer. Reimplementing it here would fork the custom-icon table
 * (provider logos) and drift the moment one is added.
 */
import React from 'react';

export { MaterialSymbol } from '../../runtime/src/ui/icons/MaterialSymbol';

/**
 * The web console does not expose the desktop tracker store or tracker routes.
 * Keep tracker references displayable as their raw keys, but do not pretend a
 * browser click can navigate to a tracker that is unavailable here.
 */
export function useResolvedTrackerReference(_referenceKey: string): null {
  return null;
}

export function navigateToTrackerReference(_reference: unknown): void {
  // Tracker navigation is a desktop-only capability.
}

/**
 * The rendering half of the tracker-reference surface.
 *
 * `useResolvedTrackerReference` and `navigateToTrackerReference` above were
 * stubbed for this surface already; these two were not, because nothing had
 * pulled `extension-sdk`'s `trackerReferences` module into a console build yet.
 * Monaco does -- it reaches the SDK barrel through runtime's
 * `useCollaborativeEditor` re-export -- and a bridge missing them fails the
 * production build with a bare `MISSING_EXPORT`, far from the import that
 * caused it.
 *
 * Both answer honestly rather than approximating the desktop components. The
 * chip shows the reference key as plain text: it is the information the reader
 * needs, without implying a click target this host cannot honour. The picker
 * renders nothing, because choosing a tracker item requires the desktop tracker
 * store the console does not have, and an empty control that never returns a
 * result is worse than no control.
 */
export function TrackerReferenceChip({ referenceKey }: { referenceKey: string }) {
  return <span className="tracker-reference-chip tracker-reference-chip--unlinked">{referenceKey}</span>;
}

export function TrackerReferencePicker(): null {
  return null;
}

/**
 * There is no document path in a browser.
 *
 * The desktop value is an absolute path on disk, which is what extensions use
 * to resolve assets relative to the file they are editing. A collaborative
 * document here is a room, not a file, so both halves are null -- the same
 * answer the desktop context gives outside a provider, so callers already
 * handle it.
 */
export function useDocumentPath(): { documentPath: string | null; documentDir: string | null } {
  return { documentPath: null, documentDir: null };
}

// The Calc Sheets editors render with Monaco. The collab bundle does not export
// these, and webMonacoBundle.tsx already imports MonacoEditor from the same
// runtime-source path, so this adds no second compiled copy. Loaded on first
// render, like webMonacoBundle, so importing the bridge never pulls in Monaco.
function lazyRuntimeComponent<P>(load: () => Promise<React.ComponentType<P>>): React.ComponentType<P> {
  const Lazy = React.lazy(async () => ({ default: await load() }));
  return function LazyRuntimeComponent(props: P) {
    return (
      <React.Suspense fallback={null}>
        <Lazy {...(props as P & React.JSX.IntrinsicAttributes)} />
      </React.Suspense>
    );
  };
}

export const MonacoEditor = lazyRuntimeComponent(
  async () => (await import('../../runtime/src/editors/MonacoEditor')).MonacoEditor,
);
export const MonacoCodeEditor = lazyRuntimeComponent(
  async () => (await import('../../runtime/src/editors/MonacoCodeEditor')).MonacoCodeEditor,
);

// Browser extensions share this service; without a host capture provider its
// capture methods reject explicitly rather than importing a desktop API.
export { screenshotService } from '../../runtime/src/services/ScreenshotService';
