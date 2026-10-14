/**
 * Resume a Claude Agent session once the usage limit that stopped it resets.
 *
 * The provider attaches the reset time to the turn's terminal error
 * (`usageLimitResetsAtMs`). With the opt-in setting on, this schedules a
 * session wakeup a minute after the reset; the existing scheduler persists it,
 * shows it in the wakeup banner and fires it. Any later turn on the session
 * cancels it, since the session is moving again without it.
 *
 * Resume wakeups are recognized by their reason string. Wakeups an agent
 * scheduled for itself carry a different reason and are never touched here.
 *
 * The store, settings and scheduler are injected once at startup rather than
 * imported: MessageStreamingHandler imports this module, and RepositoryManager
 * would drag the whole sync/workspace graph into it.
 */

import log from 'electron-log/main';
import type { SessionWakeup, SessionWakeupsStore } from '../PGLiteSessionWakeupsStore';
import type { CreateWakeupRequest } from '../sessionWakeupCreation';

const logger = log.scope('UsageLimitAutoResume');

export const USAGE_LIMIT_RESUME_REASON = 'Resuming after the usage limit reset';

export const USAGE_LIMIT_RESUME_PROMPT =
  'Continue.\n\n<NIMBALYST_SYSTEM_MESSAGE>Your previous turn stopped because the Claude usage limit was reached. ' +
  'The limit has now reset. Pick up where you left off.</NIMBALYST_SYSTEM_MESSAGE>';

/** Let the limit actually clear before the first request. */
const RESUME_BUFFER_MS = 60_000;
/** Sessions blocked by the same limit resume one after another, not all at once. */
const RESUME_STAGGER_MS = 30_000;
/** The scheduler's own ceiling for a wakeup. */
const MAX_RESUME_AHEAD_MS = 7 * 24 * 60 * 60 * 1000;

export type UsageLimitResumePlan = { fireAt: number } | { skip: string };

export function planUsageLimitResume(input: {
  resetsAtMs: number;
  now: number;
  /** Other sessions already waiting on a usage-limit resume. */
  otherPendingResumes: number;
}): UsageLimitResumePlan {
  const { resetsAtMs, now, otherPendingResumes } = input;
  if (!Number.isFinite(resetsAtMs)) return { skip: 'no reset time' };
  if (resetsAtMs - now > MAX_RESUME_AHEAD_MS) return { skip: 'reset is more than 7 days away' };
  // A reset already in the past (the user enabled this later) resumes shortly.
  const base = Math.max(resetsAtMs, now);
  return { fireAt: base + RESUME_BUFFER_MS + otherPendingResumes * RESUME_STAGGER_MS };
}

export interface UsageLimitResumeDeps {
  store: SessionWakeupsStore;
  isEnabled: () => boolean;
  setEnabled: (enabled: boolean) => void;
  create: (request: CreateWakeupRequest) => Promise<SessionWakeup>;
  cancel: (id: string) => Promise<unknown>;
  now: () => number;
}

let configuredDeps: UsageLimitResumeDeps | null = null;

/** Called once at startup, next to the wakeup scheduler's own configure(). */
export function configureUsageLimitAutoResume(deps: UsageLimitResumeDeps): void {
  configuredDeps = deps;
}

function requireDeps(): UsageLimitResumeDeps {
  if (!configuredDeps) throw new Error('configureUsageLimitAutoResume() was not called');
  return configuredDeps;
}

function isUsageLimitResume(row: SessionWakeup): boolean {
  return row.reason === USAGE_LIMIT_RESUME_REASON;
}

/** Schedule the resume regardless of the setting. The widget's button calls this directly. */
export async function scheduleUsageLimitResume(
  request: { sessionId: string; workspacePath: string; resetsAtMs: number },
  deps: UsageLimitResumeDeps = requireDeps(),
): Promise<UsageLimitResumePlan> {
  const pending = await deps.store.listPending();
  const otherPendingResumes = pending.filter(
    (row) => isUsageLimitResume(row) && row.sessionId !== request.sessionId,
  ).length;
  const plan = planUsageLimitResume({ resetsAtMs: request.resetsAtMs, now: deps.now(), otherPendingResumes });
  if ('skip' in plan) {
    logger.info('Not scheduling usage-limit resume', { sessionId: request.sessionId, reason: plan.skip });
    return plan;
  }
  await deps.create({
    sessionId: request.sessionId,
    workspacePath: request.workspacePath,
    prompt: USAGE_LIMIT_RESUME_PROMPT,
    reason: USAGE_LIMIT_RESUME_REASON,
    fireAt: new Date(plan.fireAt),
  });
  logger.info('Scheduled usage-limit resume', {
    sessionId: request.sessionId,
    fireAt: new Date(plan.fireAt).toISOString(),
  });
  return plan;
}

/** The turn-end path: schedule only when the user turned auto-resume on. */
export async function maybeScheduleUsageLimitResume(
  request: { sessionId: string; workspacePath: string; resetsAtMs: number },
  deps: UsageLimitResumeDeps = requireDeps(),
): Promise<UsageLimitResumePlan> {
  if (!deps.isEnabled()) return { skip: 'auto-resume is off' };
  return scheduleUsageLimitResume(request, deps);
}

/**
 * The transcript card's switch. Turning it on also schedules the session the
 * card belongs to, whose turn already ended before the setting existed.
 * Turning it off cancels every resume that has not fired yet.
 */
export async function setUsageLimitAutoResume(
  enabled: boolean,
  current?: { sessionId: string; workspacePath: string; resetsAtMs: number },
  deps: UsageLimitResumeDeps = requireDeps(),
): Promise<UsageLimitResumePlan | null> {
  deps.setEnabled(enabled);
  if (enabled) return current ? scheduleUsageLimitResume(current, deps) : null;

  const pending = await deps.store.listPending();
  const sessionRows = current ? await deps.store.listActiveForSession(current.sessionId) : [];
  const ids = new Set([...pending, ...sessionRows].filter(isUsageLimitResume).map((row) => row.id));
  for (const id of ids) await deps.cancel(id);
  return null;
}

/** A new turn started, so a pending resume would only send a stray "Continue". */
export async function cancelUsageLimitResume(
  sessionId: string,
  deps: UsageLimitResumeDeps = requireDeps(),
): Promise<void> {
  const active = await deps.store.listActiveForSession(sessionId);
  for (const row of active) {
    if (isUsageLimitResume(row)) await deps.cancel(row.id);
  }
}
