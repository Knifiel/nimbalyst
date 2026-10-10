/**
 * Project settings for the worktree setup step: files copied from the project
 * into every new worktree (paths relative to the project root, one per line)
 * and a command run in a terminal of the new worktree.
 *
 * Kept in this project's workspace state on this machine, since `.env` files
 * and install commands are personal.
 */

import React, { useEffect, useState } from 'react';

interface WorktreeSetupPanelProps {
  workspacePath: string;
  workspaceName: string;
}

export const WorktreeSetupPanel: React.FC<WorktreeSetupPanelProps> = ({ workspacePath, workspaceName }) => {
  const [copyText, setCopyText] = useState('');
  const [command, setCommand] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle');

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    window.electronAPI?.invoke?.('workspace:get-state', workspacePath)
      .then((state: { worktreeSetup?: { copy?: string[]; command?: string } } | null) => {
        if (cancelled) return;
        setCopyText((state?.worktreeSetup?.copy ?? []).join('\n'));
        setCommand(state?.worktreeSetup?.command ?? '');
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => { cancelled = true; };
  }, [workspacePath]);

  const save = async () => {
    const copy = copyText.split('\n').map(line => line.trim()).filter(Boolean);
    try {
      await window.electronAPI.invoke('workspace:update-state', workspacePath, {
        worktreeSetup: { copy, command: command.trim() || undefined },
      });
      setStatus('saved');
    } catch {
      setStatus('error');
    }
  };

  return (
    <div className="worktree-setup-panel flex flex-col h-full p-6 gap-6" data-testid="worktree-setup-panel">
      <div className="panel-header">
        <h2 className="m-0 mb-2 text-lg font-semibold text-[var(--nim-text)]">Worktree Setup</h2>
        <p className="panel-description m-0 text-[13px] text-[var(--nim-text-muted)] leading-normal">
          What every new worktree of <strong className="text-[var(--nim-text)] font-medium">{workspaceName}</strong> gets
          after it is created. Files are copied without overwriting anything; the command runs in a terminal of the
          worktree, with <code>NIMBALYST_WORKTREE_PATH</code>, <code>_NAME</code>, <code>_BRANCH</code>,
          <code> _PROJECT_PATH</code> and <code>_GROUP_MEMBERS</code> set.
        </p>
      </div>

      <label className="worktree-setup-copy flex flex-col gap-1.5">
        <span className="text-[12px] font-semibold text-[var(--nim-text)] uppercase tracking-wider">Files to copy</span>
        <span className="text-[12px] text-[var(--nim-text-muted)]">Paths relative to the project, one per line, such as <code>.env</code> or <code>api/.env</code>.</span>
        <textarea
          className="px-3 py-2 text-[13px] font-mono rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] text-[var(--nim-text)] min-h-[120px] select-text"
          value={copyText}
          disabled={!loaded}
          onChange={(e) => { setCopyText(e.target.value); setStatus('idle'); }}
          data-testid="worktree-setup-copy-input"
          spellCheck={false}
        />
      </label>

      <label className="worktree-setup-command flex flex-col gap-1.5">
        <span className="text-[12px] font-semibold text-[var(--nim-text)] uppercase tracking-wider">Setup command</span>
        <input
          type="text"
          className="px-3 py-2 text-[13px] font-mono rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] text-[var(--nim-text)]"
          value={command}
          disabled={!loaded}
          placeholder="e.g. pnpm install"
          onChange={(e) => { setCommand(e.target.value); setStatus('idle'); }}
          data-testid="worktree-setup-command-input"
          spellCheck={false}
        />
      </label>

      <div className="flex items-center gap-3">
        <button
          type="button"
          className="nim-btn-primary px-4 py-1.5 text-[13px] rounded-md"
          disabled={!loaded}
          onClick={() => void save()}
          data-testid="worktree-setup-save"
        >
          Save
        </button>
        {status === 'saved' && <span className="text-[12px] text-[var(--nim-text-muted)]">Saved</span>}
        {status === 'error' && <span className="text-[12px] text-nim-error">Could not save</span>}
      </div>
    </div>
  );
};
