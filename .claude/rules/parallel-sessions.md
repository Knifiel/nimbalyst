## Parallel sessions must not share files

Several sessions run against this checkout at once. A whole-file `Write` silently reverts another session's uncommitted work, and careful `Edit` calls on the same file produce a change neither session can commit alone.

Before launching parallel work, list the files each slice touches and confirm the sets are disjoint. Source files alone are not a disjointness check; the usual collisions are `CHANGELOG.md`, `docs/FEATURE_INVENTORY.md`, `CLAUDE.md` and `.claude/rules/*`, `package.json` and the lockfile, barrel `index.ts` files, shared type modules, and registries such as `KeyboardShortcutsDialog.tsx`. If two slices need one of these, they are one slice, or one slice owns the file for the batch.

Never edit `CHANGELOG.md` before a commit is requested, even when working alone. The entry is written as part of preparing the commit; see [/commit](../commands/commit.md). An entry written early describes code not yet in the tree and puts every concurrent session into the same file.

Orchestrator duties:

- Run the gate once for the batch. Slices run only their own targeted vitest file; concurrent full runs produce false failures.
- State the constraint in each brief: which files the slice owns, that siblings are live, and no whole-file `Write` on a file it did not create.
- Re-grep anchors after a long wait; line numbers move.
- Decide the commit split yourself. Either slices report back and the orchestrator commits, or each slice commits strictly its own files, never the shared ones, and only on a green targeted test.
- The integrating session owns `docs/FEATURE_INVENTORY.md`; slices report capability changes in their handoff.
