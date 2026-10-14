---
paths:
  - "packages/electron/src/main/ipc/**"
  - "packages/electron/src/main/services/**"
  - "packages/runtime/src/**/services/**"
---

Read [docs/ERROR_HANDLING.md](../../docs/ERROR_HANDLING.md) before writing IPC handlers or service methods. Key points:

- Fail fast: throw on missing required parameters, never log and continue
- Workspace-scoped IPC takes `workspacePath` as a required parameter; no module-level current-workspace fallback
- Deep merge for nested workspace state updates
- Use `safeHandle` / `safeOn` from `ipcRegistry`, never raw `ipcMain.handle` / `ipcMain.on`
