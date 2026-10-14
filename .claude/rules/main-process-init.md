---
paths:
  - "packages/electron/src/main/index.ts"
  - "packages/electron/src/main/bootstrap.ts"
  - "packages/electron/src/main/ipc/**"
  - "packages/electron/src/main/utils/store.ts"
  - "packages/electron/src/main/utils/ipcRegistry.ts"
---

Read [packages/electron/MAIN_PROCESS_INIT.md](../../packages/electron/MAIN_PROCESS_INIT.md) before changing main-process startup. Key points:

- `bootstrap.ts` uses a dynamic `import('./index.js')` on purpose; do not convert it. Everywhere else uses static imports, and the build's main-bundle require policy rejects lazy chunks
- Singletons that read `app.getPath()` initialize lazily
- `safeHandle` / `safeOn` instead of `ipcMain.handle` / `ipcMain.on`
- `main/index.ts` is the most-edited file in the repo; put new init in a per-domain module, not inline
