---
paths:
  - "packages/electron/src/main/database/**"
  - "packages/electron/src/main/services/**/*Database*"
  - "packages/electron/src/main/services/**/*Backup*"
  - "packages/electron/src/main/services/**/*Recovery*"
  - "packages/electron/src/main/services/**/*Migration*"
  - "**/migrations/**"
  - "packages/runtime/src/sync/**"
---

## Never destroy user data on a heuristic

A path that renames, moves, truncates, overwrites, or deletes user data is destructive whatever the function is called. Sessions and document history exist in one place on one disk; collab does not back them up.

Why this rule exists (GitHub #1347): a "corruption recovery" feature renamed the live `pglite-db/` aside on any WASM abort for nine months. Six installs came up empty, three migrated the empty database and made the loss permanent, and the failure dialog told 64 users to delete their data without mentioning the three rolling backups next to it.

Requirements for any destructive path:

1. Retry before you destroy. One failure is not evidence the data is bad.
2. Verify the damage with an integrity check, a size, or a parse, never a substring match on an error message. If you cannot verify, you may not destroy.
3. Emit the telemetry event before acting, so a mid-recovery death still reports.
4. Ask, unless the app genuinely cannot start.
5. Leave a recoverable artifact and give it a launch heartbeat the same day.

Restore-from-backup is always the primary action offered to the user. A destructive option is secondary, names what will be lost, and comes only after a backup was taken. Never print an instruction telling the user to delete their data.

Put the decision in a pure function that takes the facts and returns the plan, and test the plan; `packages/electron/src/main/database/pgliteInitRecovery.js` is the pattern. Test two launches, not one, for anything that persists a decision at first boot. Size synchronous checks against a realistic multi-gigabyte file. A verifier that only compares the target against its own source passes when the source is empty; take one signal from outside the thing being migrated.
