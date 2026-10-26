/**
 * Delivers an answer, or a commit outcome, from a card whose MCP waiter is gone.
 *
 * The waiter is gone when Stop released the card (#1116) or when its call ended
 * with the subprocess (#773, #1647). The caller has already written the card's
 * terminal result; this tells the agent, as a new message.
 *
 * A released turn keeps running until the agent ends it, and its background
 * subagents run on. sendMessage would replace that request and kill them, so a
 * session whose turn is still in flight gets the message through the prompt
 * queue, which delivers it when the turn ends, or into a turn that is only
 * draining background tasks. An idle session is resumed at once.
 */

import { createHash } from 'node:crypto';
import { getSessionStateManager } from '@nimbalyst/runtime/ai/server/SessionStateManager';
import { getQueuedPromptsStore } from '../RepositoryManager';
import { hasLiveInteractivePrompt } from '../../mcp/tools/interactivePromptLiveness';
import { isLeadTurnPending } from './drainFollowUp';

export type ResumeSessionWithAnswer = (args: {
  event: Electron.IpcMainInvokeEvent;
  sessionId: string;
  workspacePath: string | undefined;
  message: string;
}) => Promise<unknown>;

interface AnswerResumeHost {
  /** Starts a turn with the message; settles when that turn does. */
  send: ResumeSessionWithAnswer;
  publish(sessionId: string): Promise<void>;
  drive(sessionId: string, workspacePath: string): Promise<unknown>;
}

let host: AnswerResumeHost | null = null;

/** Wired by AIService, which owns the send-message path and the queue driver. */
export function configureAnswerResume(value: AnswerResumeHost): void {
  host = value;
}

/** Resumes started here that have not settled. Their turn may not be marked running yet. */
const sending = new Map<string, Promise<unknown>>();

/** True while the session has a turn that a new sendMessage would replace. */
export function isTurnInFlight(sessionId: string): boolean {
  if (sending.has(sessionId) || hasLiveInteractivePrompt(sessionId) || isLeadTurnPending(sessionId)) return true;
  const state = getSessionStateManager().getSessionState(sessionId);
  return !!state && (state.status === 'running' || state.status === 'waiting_for_input' || state.isStreaming);
}

const queueId = (sessionId: string, promptId: string) =>
  `answer-resume-${createHash('sha256').update(JSON.stringify([sessionId, promptId])).digest('hex')}`;

/** The live tool result's wording, so the agent reads the same outcome either way. */
export function buildCommitProposalResumeMessage(response: {
  action?: string;
  commitHash?: string;
  commitDate?: string;
  commitMessage?: string;
  filesCommitted?: string[];
  error?: string;
}): string | null {
  let outcome: string;
  if (response.error) outcome = `Commit failed: ${response.error}`;
  else if (response.action === 'committed' && response.commitHash) {
    const files = response.filesCommitted?.length;
    outcome = `User confirmed and committed${files ? ` ${files} file(s)` : ''}.\nCommit hash: ${response.commitHash}`
      + (response.commitDate ? `\nCommit date: ${response.commitDate}` : '')
      + (response.commitMessage ? `\nCommit message: ${response.commitMessage}` : '');
  } else if (response.action === 'committed' || response.action === 'error') {
    outcome = 'Commit failed: No commit hash returned. The files may not have been staged correctly.';
  } else return null;
  return `[Resuming after the user answered your commit proposal]\n\n${outcome}`;
}

export async function resumeWithAnswer(args: {
  event: Electron.IpcMainInvokeEvent;
  sessionId: string;
  promptId: string;
  workspacePath: string | undefined;
  message: string;
}): Promise<'sent' | 'queued' | 'failed'> {
  const { event, sessionId, promptId, workspacePath, message } = args;
  if (!host) {
    console.error(`[AnswerResume] Resume is not configured; the answer to ${promptId} was not delivered`);
    return 'failed';
  }
  const resumeHost = host;

  if (!isTurnInFlight(sessionId)) {
    console.log(`[AnswerResume] No turn in flight, resuming session ${sessionId} with the answer to ${promptId}`);
    const pending = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => resumeHost.send({ event, sessionId, workspacePath, message }));
    sending.set(sessionId, pending);
    void pending
      .catch((err) => console.error(`[AnswerResume] Failed to resume session ${sessionId}: ${err}`))
      .finally(() => {
        if (sending.get(sessionId) === pending) sending.delete(sessionId);
      });
    return 'sent';
  }

  try {
    const queue = getQueuedPromptsStore();
    const id = queueId(sessionId, promptId);
    if (!(await queue.get(id))) {
      // Not a human turn: it must not supersede other open questions.
      await queue.create({ id, sessionId, prompt: message, documentContext: { promptOrigin: 'interactive-question' } });
    }
    await resumeHost.publish(sessionId);
  } catch (err) {
    // The card is already closed with its answer; only the message is lost.
    console.error(`[AnswerResume] Failed to queue the answer to ${promptId} for session ${sessionId}: ${err}`);
    return 'failed';
  }
  console.log(`[AnswerResume] Turn in flight for session ${sessionId}; queued the answer to ${promptId}`);
  if (!workspacePath) return 'queued';
  const drive = () => {
    resumeHost.drive(sessionId, workspacePath).catch((err) =>
      console.error(`[AnswerResume] Queue drive failed for session ${sessionId}: ${err}`));
  };
  // A resume sent here may not have marked its turn running yet, and a drive
  // now would dispatch beside it. Drive once it settles instead.
  const started = sending.get(sessionId);
  if (started) void started.then(drive, drive);
  else drive();
  return 'queued';
}
