---
paths:
  - "packages/collab-protocol/**"
  - "packages/collab-client/**"
  - "packages/runtime/src/sync/**"
  - "packages/electron/src/main/sync/**"
  - "packages/ios/**/*.swift"
  - "packages/android/**/*.kt"
  - "**/*.sql"
  - "**/migrations/**"
---

Read [docs/NAMING_CONVENTIONS.md](../../docs/NAMING_CONVENTIONS.md) before designing wire protocols, sync code, or SQL schemas. Key points:

- `camelCase` for all wire-format JSON, including message type discriminators (`'syncRequest'`, not `'sync_request'`)
- `snake_case` only for SQL column names; map to `camelCase` at the boundary
