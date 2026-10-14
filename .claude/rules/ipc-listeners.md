---
paths:
  - "packages/electron/src/renderer/store/**"
  - "packages/electron/src/renderer/components/**/*.tsx"
  - "packages/electron/src/renderer/hooks/**"
  - "packages/electron/src/renderer/services/**"
  - "packages/electron/src/preload/**"
---

Read [docs/IPC_LISTENERS.md](../../docs/IPC_LISTENERS.md) before touching IPC events or `electronAPI`. Key points:

- Components never subscribe to IPC events directly
- Central listeners in `store/listeners/` subscribe once at startup and update Jotai atoms; components read atoms
- `electronAPI.on` returns an unsubscribe closure; there is no `off`
- Debounce rapid events (file watchers, sync events)
