import {
  afterCommitProposalExecutionSettles,
  afterCommitProposalSettles,
  isCommitProposalExecuting,
  isCommitProposalInFlight,
} from '@nimbalyst/runtime/ai/server/commitProposalInFlight';
import { settleLiveInteractivePrompts } from '../../mcp/tools/interactivePromptLiveness';

export interface DeferredSendNowDeps {
  hasPendingPrompts(sessionId: string): Promise<boolean>;
  interrupt(sessionId: string): Promise<unknown>;
  drive(sessionId: string): Promise<unknown>;
  logWarn(message: string): void;
}

export interface InterruptOrigin {
  /** The user's own send-now. Anything else (meta-agent, orchestrator) is not. */
  userInitiated?: boolean;
}

const scheduled = new Set<string>();

/**
 * #1682: an interrupt must not land while a `developer_git_commit_proposal`
 * call is in flight. Meta-agent and orchestrator interrupts wait out the whole
 * call, the wait for the user included; the user's own send-now waits only for
 * a commit they confirmed. Returns true when the interrupt was deferred; once
 * the hold settles, a still-queued prompt is sent the way send-now would have
 * sent it (interrupt, then drive).
 */
export function deferInterruptDuringCommit(
  sessionId: string,
  deps: DeferredSendNowDeps,
  origin: InterruptOrigin = {},
): boolean {
  const held = origin.userInitiated ? isCommitProposalExecuting(sessionId) : isCommitProposalInFlight(sessionId);
  if (!held) return false;
  if (scheduled.has(sessionId)) return true;
  scheduled.add(sessionId);
  const afterHold = origin.userInitiated ? afterCommitProposalExecutionSettles : afterCommitProposalSettles;
  void afterHold(sessionId, async () => {
    scheduled.delete(sessionId);
    if (!(await deps.hasPendingPrompts(sessionId))) return;
    await deps.interrupt(sessionId);
    await deps.drive(sessionId);
  }).catch(error => {
    scheduled.delete(sessionId);
    deps.logWarn(`[AIService] deferred send-now after commit proposal failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
  });
  return true;
}

/**
 * Runs before an interrupt: `'deferred'` when a commit proposal holds it (see
 * above). A user's interrupt that goes ahead first closes the session's
 * waiting commit proposals for good -- the SDK interrupt rejects their calls
 * before any turn supersede runs, and the card must not stay committable.
 */
export async function prepareInterrupt(
  sessionId: string,
  deps: DeferredSendNowDeps,
  origin: InterruptOrigin = {},
): Promise<'deferred' | 'ready'> {
  if (deferInterruptDuringCommit(sessionId, deps, origin)) return 'deferred';
  if (origin.userInitiated) {
    await settleLiveInteractivePrompts(sessionId, 'superseded', prompt => prompt.kind === 'git_commit_proposal');
  }
  return 'ready';
}
