/**
 * The checkouts of a worktree group, to choose which one the Git panel works
 * on: the task folder (the project's repository) or a member clone. Each is
 * a worktree of its own repository, so status, commits, merge and rebase go
 * through the existing worktree operations with that checkout's path.
 */

import React, { useEffect, useState } from 'react';

export interface WorktreeGroupCheckout {
  id: string;
  path: string;
  /** The repository the checkout belongs to */
  repoPath: string;
  isAnchor: boolean;
}

/** The group `worktreeId` anchors, anchor first; empty while loading or for no worktree */
export function useWorktreeGroupCheckouts(worktreeId: string | null): WorktreeGroupCheckout[] {
  const [checkouts, setCheckouts] = useState<WorktreeGroupCheckout[]>([]);
  useEffect(() => {
    setCheckouts([]);
    if (!worktreeId || !window.electronAPI?.invoke) return;
    let cancelled = false;
    window.electronAPI.invoke('worktree:list-group', worktreeId)
      .then((result: { success: boolean; worktrees?: Array<{ id: string; path: string; projectPath: string; sourceFolderPath?: string }> }) => {
        if (cancelled || !result?.success || !result.worktrees) return;
        setCheckouts(result.worktrees.map((worktree, index) => ({
          id: worktree.id,
          path: worktree.path,
          repoPath: worktree.sourceFolderPath ?? worktree.projectPath,
          isAnchor: index === 0,
        })));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [worktreeId]);
  return checkouts;
}

const folderName = (repo: string) => repo.split(/[\\/]/).filter(Boolean).pop() ?? repo;

interface WorktreeGroupCheckoutPickerProps {
  checkouts: WorktreeGroupCheckout[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function WorktreeGroupCheckoutPicker({ checkouts, selectedId, onSelect }: WorktreeGroupCheckoutPickerProps) {
  return (
    <label
      className="worktree-group-checkout-picker flex items-center gap-2 px-3 py-1.5 border-b border-[var(--nim-border)] text-[12px] text-[var(--nim-text-muted)]"
      data-testid="worktree-group-checkout-picker"
    >
      <span className="shrink-0">Repository</span>
      <select
        className="flex-1 min-w-0 px-2 py-1 rounded border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] text-[var(--nim-text)] text-[12px] font-mono"
        value={selectedId ?? checkouts[0]?.id ?? ''}
        onChange={(e) => onSelect(e.target.value)}
        data-testid="worktree-group-checkout-select"
      >
        {checkouts.map(checkout => (
          <option key={checkout.id} value={checkout.id} title={checkout.path}>
            {folderName(checkout.repoPath)}{checkout.isAnchor ? ' (task folder)' : ''}
          </option>
        ))}
      </select>
    </label>
  );
}
