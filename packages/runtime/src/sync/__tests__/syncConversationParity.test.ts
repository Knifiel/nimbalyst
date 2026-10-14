import { projectRawMessagesToViewMessages } from '../../ai/server/transcript/projectRawMessages';
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { CodexAppServerRawParser } from '../../ai/server/transcript/parsers/CodexAppServerRawParser';
import type { ParseContext } from '../../ai/server/transcript/parsers/IRawMessageParser';
import { truncateContentForSync, shouldSyncMessageForSessionRoom } from '../syncContentTruncator';

const context: ParseContext = {
  sessionId: 'sync-parity', hasToolCall: () => false, hasSubagent: () => false,
  findByProviderToolCallId: async () => null, findActiveToolCallByRawProviderId: async () => null,
};

async function project(item: Record<string, unknown>, method = 'item/completed') {
  const content = JSON.stringify({ method, params: { threadId: 'thread', turnId: 'turn', item } });
  const raw = {
    id: 1, sessionId: 'sync-parity', source: 'openai-codex', direction: 'output' as const,
    content, createdAt: new Date(0),
    metadata: { transport: 'app-server', eventType: method, editGroupId: 'nimtc|call|0|1' },
  };
  expect(shouldSyncMessageForSessionRoom(raw.source, raw.metadata, content)).toBe(true);
  const projected = truncateContentForSync(content, raw.source).content;
  const beforeView = await projectRawMessagesToViewMessages([raw], raw.source);
  const afterView = await projectRawMessagesToViewMessages([{ ...raw, content: projected }], raw.source);
  expect(afterView.map(view => view.type)).toEqual(beforeView.map(view => view.type));
  return {
    beforeView, afterView,
    before: await new CodexAppServerRawParser().parseMessage(raw, context),
    after: await new CodexAppServerRawParser().parseMessage({ ...raw, content: projected }, context),
    projected,
  };
}

describe('#1711 conversation projection', () => {
  it('preserves structured sidecars and unknown conversation output fields', () => {
    const text = 'answers'.repeat(4000);
    const claude = JSON.stringify({ type: 'user', tool_use_result: { answers: { draft: text } }, message: { content: [{ type: 'tool_result', content: JSON.stringify({ answers: { draft: text } }) }] } });
    const codex = JSON.stringify({ item: { type: 'agentMessage', id: 'reply', output: text } });
    expect(truncateContentForSync(claude, 'claude-code').content === claude).toBe(true);
    expect(truncateContentForSync(codex, 'openai-codex').content === codex).toBe(true);
  });
  it('preserves user input, Claude prose and structured answers above the output budget', () => {
    const text = 'λ'.repeat(18000);
    for (const source of ['openai-codex', 'claude-code', 'custom-provider']) {
      for (const content of [text, JSON.stringify({ prompt: text })]) {
        expect(truncateContentForSync(content, source).content).toBe(content);
      }
    }
    for (const block of [
      { type: 'text', text },
      { type: 'tool_use', name: 'AskUserQuestion', input: { questions: [{ question: text }] } },
      { type: 'tool_result', tool_use_id: 'question', content: JSON.stringify({ answers: { draft: text } }) },
    ]) {
      const content = JSON.stringify({ type: 'assistant', message: { content: [block] } });
      expect(truncateContentForSync(content, 'claude-code').content).toBe(content);
    }
  });
  it.each(['commentary', 'final'])('preserves large %s replies exactly', async phase => {
    const result = await project({ id: 'answer', type: 'agentMessage', phase, text: '漢字🙂\\\"\n'.repeat(4000) });
    expect(result.before).toHaveLength(1);
    expect(result.after).toEqual(result.before);
    expect(result.beforeView.length).toBeGreaterThan(0);
    expect(result.afterView).toEqual(result.beforeView);
  });

  it.each(['item/started', 'item/completed'])('preserves actionable schemas and identity at %s', async method => {
    const result = await project({
      id: 'call', type: 'mcpToolCall', server: 'nimbalyst', tool: 'PromptForUserInput',
      status: method === 'item/started' ? 'inProgress' : 'completed',
      arguments: { fields: [{ id: 'draft', type: 'editText', label: 'Review', initialText: 'draft'.repeat(4000) }] },
      result: { content: [{ type: 'text', text: JSON.stringify({ answers: { draft: 'answer'.repeat(4000) } }) }] },
    }, method);
    expect(result.before[0]).toMatchObject({ type: 'tool_call_started', providerToolCallId: 'nimtc|call|0|1' });
    expect(result.after).toEqual(result.before);
    expect(result.beforeView.length).toBeGreaterThan(0);
    expect(result.afterView).toEqual(result.beforeView);
  });

  it('bounds many diff bodies without losing tool identity or paths', async () => {
    const changes = Array.from({ length: 15 }, (_, i) => ({ path: `/file-${i}`, kind: { type: 'update' }, diff: 'd'.repeat(3000) }));
    const result = await project({ id: 'edit', type: 'fileChange', status: 'completed', changes });
    expect(result.after.map(event => event.type)).toEqual(result.before.map(event => event.type));
    const synced = JSON.parse(result.projected).params.item;
    expect(synced.changes.map((change: { path: string }) => change.path)).toEqual(changes.map(change => change.path));
    expect(Buffer.byteLength(result.projected)).toBeLessThan(16 * 1024);
  });
});
