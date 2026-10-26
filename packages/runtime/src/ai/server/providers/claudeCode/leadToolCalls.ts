/**
 * #1116: what a Claude lead turn is blocked on, for a desktop Stop that would
 * rather release a waiting prompt than abort the turn (and the background
 * subagents running in its process).
 */
export interface LeadTurnBlockers {
  /** The lead's own tool calls (no `parent_tool_use_id`) still waiting on a result. */
  toolUseIds: string[];
  /** A permission, plan-mode or SDK question prompt is pending; none of those can be released. */
  providerPromptPending: boolean;
}

/** The lead turn's own tool calls that have no result yet. A subagent's calls never count. */
export class LeadToolCalls {
  private readonly open = new Set<string>();

  started(toolUseId: string, parentToolUseId: string | undefined): void {
    if (!parentToolUseId) this.open.add(toolUseId);
  }

  /** A result arrived, or the harness backgrounded the call: the lead no longer waits on it. */
  finished(toolUseId: string): void {
    this.open.delete(toolUseId);
  }

  ids(): string[] {
    return [...this.open];
  }
}
