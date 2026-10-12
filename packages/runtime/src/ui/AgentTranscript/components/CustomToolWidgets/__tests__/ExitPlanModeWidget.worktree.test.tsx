/**
 * Plan approval can implement the plan in a session in its own new worktree.
 * The option reaches the host's worktree path, not the same-checkout one, and
 * is not offered by hosts that cannot make worktrees. The planning session's
 * card then says where the plan went instead of "Denied", also after a reload.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Provider as JotaiProvider } from 'jotai';
import { store } from '../../../../../store/store';
import { setInteractiveWidgetHost } from '../../../../../store/atoms/interactiveWidgetHost';
import { ExitPlanModeWidget } from '../ExitPlanModeWidget';
import type { InteractiveWidgetHost } from '../InteractiveWidgetHost';
import { exitPlanModeDenialReason, type ExitPlanModeDeferral } from '../../../../../ai/exitPlanModeDeferral';

const message = {
  toolCall: { providerToolCallId: 'plan-call-1', arguments: { planFilePath: '/plans/step-2.md' }, result: '' },
} as any;

function renderWithHost(sessionId: string, host: Partial<InteractiveWidgetHost>, toolMessage = message) {
  setInteractiveWidgetHost(sessionId, host as InteractiveWidgetHost);
  return render(
    <JotaiProvider store={store}>
      <ExitPlanModeWidget message={toolMessage} workspacePath="/work" sessionId={sessionId} {...({} as any)} />
    </JotaiProvider>,
  );
}

describe('implementing an approved plan in a new worktree', () => {
  it('hands the plan to the host\'s worktree path and names the worktree', async () => {
    const host = {
      exitPlanModeStartNewSession: vi.fn().mockResolvedValue(undefined),
      exitPlanModeStartWorktreeSession: vi.fn().mockResolvedValue({ worktreeName: 'swift-falcon' }),
    };
    renderWithHost('session-with-worktrees', host);

    await act(async () => { fireEvent.click(screen.getByTestId('exit-plan-mode-new-worktree')); });

    expect(host.exitPlanModeStartWorktreeSession).toHaveBeenCalledWith('plan-call-1', '/plans/step-2.md');
    expect(host.exitPlanModeStartNewSession).not.toHaveBeenCalled();
    expect(screen.getByTestId('exit-plan-mode-widget').dataset.state).toBe('deferred');
    expect(screen.getByTestId('exit-plan-mode-deferred').textContent).toBe('Deferred to worktree swift-falcon');
  });

  // The provider's reason is the only record after a reload. "fix-error-paths"
  // also checks that a name with "error" in it is not read as a failed result.
  it.each<[ExitPlanModeDeferral, string]>([
    [{ kind: 'worktree', worktreeName: 'fix-error-paths' }, 'Deferred to worktree fix-error-paths'],
    [{ kind: 'worktree', worktreeName: null }, 'Deferred to new worktree'],
    [{ kind: 'session' }, 'Deferred to new session'],
  ])('reads %o back from the recorded tool result', (deferredTo, label) => {
    const result = exitPlanModeDenialReason({ approved: false, deferredTo });
    const reloaded = { toolCall: { ...message.toolCall, result } } as any;
    renderWithHost(`reloaded-${label}`, { exitPlanModeStartNewSession: vi.fn() }, reloaded);

    expect(screen.getByTestId('exit-plan-mode-deferred').textContent).toBe(label);
  });

  it('is not offered by a host without worktrees', () => {
    renderWithHost('session-without-worktrees', { exitPlanModeStartNewSession: vi.fn() });

    expect(screen.queryByTestId('exit-plan-mode-new-worktree')).toBeNull();
    screen.getByTestId('exit-plan-mode-new-session');
  });
});
