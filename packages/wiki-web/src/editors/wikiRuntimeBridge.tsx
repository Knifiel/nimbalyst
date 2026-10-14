/**
 * `@nimbalyst/runtime` for extension bundles in the wiki's browser view: the
 * shared browser bridge, with Monaco self-hosted (see `monacoSetup.ts`). The
 * local exports below take precedence over the re-exported ones.
 */
import React from 'react';

export * from '@nimbalyst/web-editors/runtime-bridge';

function lazyMonaco<P>(load: () => Promise<React.ComponentType<P>>): React.ComponentType<P> {
  const Lazy = React.lazy(async () => {
    await import('./monacoSetup');
    return { default: await load() };
  });
  return function LazyMonaco(props: P) {
    return (
      <React.Suspense fallback={null}>
        <Lazy {...(props as P & React.JSX.IntrinsicAttributes)} />
      </React.Suspense>
    );
  };
}

export const MonacoEditor = lazyMonaco(
  async () => (await import('@nimbalyst/runtime-source/editors/MonacoEditor')).MonacoEditor,
);
export const MonacoCodeEditor = lazyMonaco(
  async () => (await import('@nimbalyst/runtime-source/editors/MonacoCodeEditor')).MonacoCodeEditor,
);
