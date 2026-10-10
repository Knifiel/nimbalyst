/**
 * Plan approval can implement the plan in a session in its own new worktree.
 * The option reaches the host's worktree path, not the same-checkout one, and
 * is not offered by hosts that cannot make worktrees.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Provider as JotaiProvider } from 'jotai';
import { store } from '../../../../../store/store';
import { setInteractiveWidgetHost } from '../../../../../store/atoms/interactiveWidgetHost';
import { ExitPlanModeWidget } from '../ExitPlanModeWidget';
import type { InteractiveWidgetHost } from '../InteractiveWidgetHost';

const message = {
  toolCall: { providerToolCallId: 'plan-call-1', arguments: { planFilePath: '/plans/step-2.md' }, result: '' },
} as any;

function renderWithHost(sessionId: string, host: Partial<InteractiveWidgetHost>) {
  setInteractiveWidgetHost(sessionId, host as InteractiveWidgetHost);
  return render(
    <JotaiProvider store={store}>
      <ExitPlanModeWidget message={message} workspacePath="/work" sessionId={sessionId} {...({} as any)} />
    </JotaiProvider>,
  );
}

describe('implementing an approved plan in a new worktree', () => {
  it('hands the plan to the host\'s worktree path', async () => {
    const host = {
      exitPlanModeStartNewSession: vi.fn().mockResolvedValue(undefined),
      exitPlanModeStartWorktreeSession: vi.fn().mockResolvedValue(undefined),
    };
    renderWithHost('session-with-worktrees', host);

    await act(async () => { fireEvent.click(screen.getByTestId('exit-plan-mode-new-worktree')); });

    expect(host.exitPlanModeStartWorktreeSession).toHaveBeenCalledWith('plan-call-1', '/plans/step-2.md');
    expect(host.exitPlanModeStartNewSession).not.toHaveBeenCalled();
  });

  it('is not offered by a host without worktrees', () => {
    renderWithHost('session-without-worktrees', { exitPlanModeStartNewSession: vi.fn() });

    expect(screen.queryByTestId('exit-plan-mode-new-worktree')).toBeNull();
    screen.getByTestId('exit-plan-mode-new-session');
  });
});
