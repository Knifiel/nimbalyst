---
paths:
  - "packages/electron/src/renderer/**/*.tsx"
  - "packages/electron/src/renderer/**/*.css"
  - "packages/runtime/src/editor/**/*.tsx"
  - "packages/runtime/src/editor/**/*.css"
  - "packages/runtime/src/ui/**"
  - "**/tailwind.config.*"
  - "**/postcss.config.*"
---

Read [docs/UI_PATTERNS.md](../../docs/UI_PATTERNS.md) before changing UI. Key points:

- `@container` queries, not `@media`, for responsive layouts
- Only the canonical `--nim-*` CSS variable names
- Ternaries for mutually exclusive Tailwind class states
- Content areas opt in to selection with `select-text`
- Every meaningful component root gets a stable kebab-case class ([REACT_DOM_MARKERS.md](../../docs/REACT_DOM_MARKERS.md))
