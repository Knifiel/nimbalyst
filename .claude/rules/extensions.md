---
paths:
  - "packages/extensions/**"
  - "packages/extension-sdk/**"
---

Read [docs/EXTENSION_ARCHITECTURE.md](../../docs/EXTENSION_ARCHITECTURE.md) before changing an extension or the SDK: the EditorHost contract, supported editor types, the manifest format, and the build rules. Apply an extension with `extension_reload` or `extension_install`; a manual build does not install it, and backend modules need a toggle off and on.
