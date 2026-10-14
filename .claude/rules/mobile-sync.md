---
paths:
  - "packages/runtime/src/sync/**"
  - "packages/electron/src/main/services/SyncManager.ts"
  - "packages/electron/src/main/services/sync/**"
  - "packages/electron/src/main/services/ai/MobileSyncHandler.ts"
  - "packages/collab-protocol/**"
  - "packages/ios/NimbalystNative/Sources/Sync/**"
  - "packages/android/**/sync/**"
---

## Mobile sync: desktop to iOS and Android

The personal sync path has failed the same way repeatedly: a send whose outcome nobody read, an ack that raced the state it described, a consumer that trusted whatever arrived last. Four fixes on 2026-09-12 re-fixed two areas already fixed in August.

### Every send returns an outcome, and the caller reads it

- `pushChange` and its siblings return a `PushChangeOutcome` instead of throwing. A caller that fires it without reading `published` has decided the phone does not need the data; say so in a comment or read the outcome.
- On iOS, no request leaves `SyncManager` without a completion, a timeout, and a place for the failure to land. `SessionCreationRequests.swift` is the template.
- `catch { logger.error(...) }` is not error handling here. The failure feeds `syncError` or a named retry, or the catch carries a comment saying why silence is correct.

### Ack after persist

- Desktop answers a phone request only after the state the answer refers to has a publish outcome. On an unpublished outcome, answer `success: false` with the reason.
- iOS completes a request only when the committed row is observable, not when the ack arrives (`SessionCreationTracker.swift`).

### Guard every consumer on revision or timestamp

- Every apply path compares against the last applied revision, sequence, or timestamp and rejects the stale one, as the v2 index page path in `IndexReplicationEntry.swift` does.
- A field that exists to order writes is compared, not merely carried. Desktop-side version counters persist across restarts.

### Commit local state after the send, or record that it did not send

- On desktop, capture the socket, connection generation, and cache identity before the encryption `await`, re-check after, and set the cache only after `socket.send` returns (`CollabV3Sync.ts` `sendIndexUpdate`).
- On iOS, an optimistic local write is fine for the UI, but the send outcome is recorded and the row re-published on reconnect.

### The sync layer owns sync, not a view

Publishing any slice must not depend on a renderer component or SwiftUI view mounting. Reconnect re-drives every slice.

### A wire field lands on both sides plus the fixture, in one commit

Wire types are hand-mirrored in `packages/collab-protocol`, `SyncProtocol.swift`, and Android's `sync/*Protocol.kt`. The golden fixtures in `packages/collab-protocol/fixtures/` are the executable contract and fail the TypeScript, Swift, and Kotlin tests when a side is missing. An inbound field without its outbound counterpart is a local write with a comment promising propagation that never happens.

### Failing test first, and keep the file smaller

A sync fix starts with a fixture or round-trip scenario that fails on current code. `CollabV3Sync.ts`, `SyncManager.swift`, and `SyncManager.ts` may not grow; extract what you touch. Local PGLite or GRDB state is not proof of server state.
