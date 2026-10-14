## End-to-end verification before declaring victory

For a bug whose verification needs a `/restart` or a user exercising a UI flow, the first deliverable is a failing test that the fix must make pass. Run it, confirm it fails, then fix.

- "Tests pass" is not "the user can do the thing". A unit test on the patched function does not cover a bug that only shows after restart.
- Never announce "fixed" without observing the change: a test that flipped red to green, or a log line showing the failing step succeed. Otherwise say "I made the change; the path is unverified end-to-end."
- For collab and sync bugs, verify both sides. Local PGLite or GRDB state matching the fixture says nothing about the server-side Y.Doc or Durable Object.
- A `try { } catch { console.error }` around your change silently swallows it. Grep `main.log` for the catch message after exercising the path.
- If a fix needed a restart to test, the next session writes a test that does not (scripted IPC, headless E2E, mocked main). Each failed restart cycle costs the user time.

This applies to anything reported "still not fixed after restart", any change to main-process init, IPC handlers, sync handlers, or Y.Doc seeding, UI bugs that only show after full reload, and any conversation where the user has already restarted once. The 2026-05-20 tracker-body workstream announced "fixed" four times on code reading alone before the user stopped it.
