---
paths:
  - "packages/electron/src/main/database/**"
  - "packages/electron/src/main/services/**/*Database*"
  - "**/migrations/**"
  - "packages/electron/src/main/utils/timestampUtils.ts"
---

Read [packages/electron/DATABASE.md](../../packages/electron/DATABASE.md) before touching the database. Key points:

- Both PGLite and better-sqlite3 are live; code must work on either
- `data->'key'` is a parsed object on PGLite and a JSON string on SQLite; parse defensively or select the whole column
- Booleans go through `toDbBoolean` / `fromDbBoolean`
- Every timestamp column is `TIMESTAMPTZ`; pass `Date` objects, read via `toMillis()`
- Never `app.exit()`; it skips backup and shutdown. Use `app.quit()`
- Never `localStorage` in the renderer; route through IPC to app-settings, workspace-settings, or the database
- Defer startup maintenance with `runWhenFirstUsable`; never run an unbounded scan at startup
