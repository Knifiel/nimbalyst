---
paths:
  - "packages/electron/src/main/utils/store.ts"
  - "packages/electron/src/main/ipc/WorkspaceHandlers.ts"
  - "packages/electron/src/renderer/store/atoms/appSettings.ts"
  - "packages/electron/src/renderer/store/atoms/workstreamState.ts"
  - "**/*State*.ts"
  - "**/*Store*.ts"
  - "**/*Merge*.ts"
---

Read [docs/STATE_PERSISTENCE.md](../../docs/STATE_PERSISTENCE.md) before adding a field to persisted state. Key points:

- Persisted state may lack fields added after it was saved
- Always use `createDefault*()` functions with every field defaulted, and merge loaded data with `??`
- Ask: what happens when a user with old data loads this code?
- Never spread the whole settings object into `aiSaveSettings`
