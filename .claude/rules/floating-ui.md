---
paths:
  - "packages/electron/src/renderer/**/*.tsx"
  - "packages/runtime/src/**/*.tsx"
  - "packages/collab-client/src/**/*.tsx"
  - "packages/extensions/**/*.tsx"
---

## Use @floating-ui/react for all popover, tooltip, and menu positioning

Never hand-compute `position: fixed` coordinates from `getBoundingClientRect()` and `window.innerHeight`; it breaks at viewport edges, inside transformed containers, and on scroll.

```tsx
import { useFloating, offset, flip, shift, FloatingPortal, useInteractions, useDismiss } from '@floating-ui/react';

const { refs, floatingStyles, context } = useFloating({
  elements: { reference: virtualRef }, // or refs.setReference on a real element
  placement: 'top-start',
  middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
});

return <FloatingPortal><div ref={refs.setFloating} style={floatingStyles}>...</div></FloatingPortal>;
```

- Always render through `FloatingPortal` to escape `overflow: hidden`.
- Context menus add `useDismiss`, `useRole('menu')`, and `useInteractions`.
- Extensions add `@floating-ui/react` to their own `package.json` so it bundles.
