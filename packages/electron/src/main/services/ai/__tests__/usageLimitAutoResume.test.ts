// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron-log/main', () => ({ default: { scope: () => ({ info: vi.fn() }) } }));

import type { SessionWakeup, SessionWakeupsStore } from '../../PGLiteSessionWakeupsStore';
import {
  USAGE_LIMIT_RESUME_REASON,
  cancelUsageLimitResume,
  maybeScheduleUsageLimitResume,
  planUsageLimitResume,
  type UsageLimitResumeDeps,
} from '../usageLimitAutoResume';

const NOW = 1_000_000_000_000;
const MINUTE = 60_000;

function row(overrides: Partial<SessionWakeup>): SessionWakeup {
  return {
    id: 'w1', sessionId: 's1', workspaceId: '/ws', prompt: 'p', reason: USAGE_LIMIT_RESUME_REASON,
    fireAt: NOW, status: 'pending', createdAt: NOW, firedAt: null, error: null, ...overrides,
  };
}

function deps(rows: SessionWakeup[], enabled = true): UsageLimitResumeDeps & {
  create: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn>;
} {
  const store = {
    listPending: async () => rows.filter((r) => r.status === 'pending'),
    listActiveForSession: async (sessionId: string) => rows.filter((r) => r.sessionId === sessionId),
  } as unknown as SessionWakeupsStore;
  return { store, isEnabled: () => enabled, setEnabled: vi.fn(), create: vi.fn(async () => row({})), cancel: vi.fn(async () => null), now: () => NOW };
}

describe('planUsageLimitResume', () => {
  it('fires a minute after the reset, staggered behind other blocked sessions, never beyond 7 days', () => {
    expect(planUsageLimitResume({ resetsAtMs: NOW + 90 * MINUTE, now: NOW, otherPendingResumes: 0 }))
      .toEqual({ fireAt: NOW + 91 * MINUTE });
    expect(planUsageLimitResume({ resetsAtMs: NOW + 90 * MINUTE, now: NOW, otherPendingResumes: 2 }))
      .toEqual({ fireAt: NOW + 92 * MINUTE });
    // Enabled after the reset already passed: resume shortly instead of in the past.
    expect(planUsageLimitResume({ resetsAtMs: NOW - 120 * MINUTE, now: NOW, otherPendingResumes: 0 }))
      .toEqual({ fireAt: NOW + MINUTE });
    expect(planUsageLimitResume({ resetsAtMs: NOW + 8 * 24 * 60 * MINUTE, now: NOW, otherPendingResumes: 0 }))
      .toHaveProperty('skip');
  });
});

describe('usage-limit resume scheduling', () => {
  it('schedules only when enabled, counting other sessions but not its own replaced row', async () => {
    const rows = [row({ id: 'own', sessionId: 's1' }), row({ id: 'other', sessionId: 's2' }), row({ id: 'agent', sessionId: 's3', reason: 'agent check-in' })];

    const off = deps(rows, false);
    await maybeScheduleUsageLimitResume({ sessionId: 's1', workspacePath: '/ws', resetsAtMs: NOW + 10 * MINUTE }, off);
    expect(off.create).not.toHaveBeenCalled();

    const on = deps(rows);
    await maybeScheduleUsageLimitResume({ sessionId: 's1', workspacePath: '/ws', resetsAtMs: NOW + 10 * MINUTE }, on);
    expect(on.create).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1', workspacePath: '/ws', reason: USAGE_LIMIT_RESUME_REASON,
      fireAt: new Date(NOW + 11 * MINUTE + 30_000),
    }));
  });

  it('a new turn cancels the pending resume but leaves a wakeup the agent scheduled', async () => {
    const d = deps([row({ id: 'resume', sessionId: 's1' }), row({ id: 'agent', sessionId: 's1', reason: 'agent check-in' })]);
    await cancelUsageLimitResume('s1', d);
    expect(d.cancel.mock.calls).toEqual([['resume']]);
  });
});
