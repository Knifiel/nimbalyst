-- ----------------------------------------------------------------------------
-- 1001_worktree_groups (fork-only; fork builds up to 62d5d957b recorded it as 53)
--
-- A worktree group: one task folder (the anchor, a worktree of the project's
-- repository) holding worktrees of other repositories at their own paths
-- inside it (the members). The anchor's group_id is its own id; each
-- member's is the anchor's. NULL for every ordinary worktree.
--
-- Column and index only: no row is rewritten or removed.
--
-- PGLite mirror: worker.js, "Mirror of SQLite migration 1001". It runs on every
-- launch, which is safe because both statements use IF NOT EXISTS.
-- ----------------------------------------------------------------------------

ALTER TABLE worktrees ADD COLUMN group_id TEXT;

CREATE INDEX IF NOT EXISTS idx_worktrees_group
  ON worktrees(group_id)
  WHERE group_id IS NOT NULL;
