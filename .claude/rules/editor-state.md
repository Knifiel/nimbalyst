---
paths:
  - "packages/runtime/src/editors/**"
  - "packages/runtime/src/editor/**"
  - "packages/electron/src/renderer/components/TabEditor/**"
  - "packages/runtime/src/extensions/editorHost.ts"
  - "packages/runtime/src/extensions/useEditorLifecycle.ts"
  - "packages/extension-sdk/src/types/editor.ts"
  - "packages/extensions/**/src/editors/**"
  - "packages/extensions/**/*Editor.tsx"
---

Read [docs/EDITOR_STATE.md](../../docs/EDITOR_STATE.md) before changing editors or TabEditor. Key points:

- Do not lift editor content state up; editors own it, the parent does not store it
- Editor-host communication goes through `EditorHost`, not props
- Jotai atom families hold tab and editor metadata (dirty, processing)
- Stateful editors (Monaco, Lexical, RevoGrid) cannot be re-rendered
