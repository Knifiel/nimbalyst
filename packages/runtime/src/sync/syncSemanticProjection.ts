import { isInteractiveWidgetTool } from '../ai/server/interactivePromptTools';
import { utf8ByteLen } from '../utils/contentBytes';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined;

/**
 * Answers and control payloads are small. A JSON string above this is data
 * output (`cat data.json`, a large MCP listing) and is trimmed like any log.
 */
const MAX_STRUCTURED_RESULT_BYTES = 64 * 1024;

/** JSON results may contain answers/control data. They are not log text. */
export function isStructuredSyncResult(value: unknown): boolean {
  if (typeof value !== 'string' || utf8ByteLen(value) > MAX_STRUCTURED_RESULT_BYTES) return false;
  try { const parsed: unknown = JSON.parse(value); return parsed !== null && typeof parsed === 'object'; }
  catch { return false; }
}

export function isInteractiveSyncItem(item: RecordValue): boolean {
  const name = item.tool ?? item.name;
  if (typeof name !== 'string') return false;
  // OpenCode names MCP tools `<server>_<tool>`.
  return isInteractiveWidgetTool(name) || isInteractiveWidgetTool(name.slice(name.indexOf('_') + 1));
}

/** Slice by encoded bytes without breaking a Unicode scalar. */
export function syncTextPrefix(text: string, bytes: number): string {
  const encoded = new TextEncoder().encode(text);
  let end = Math.min(encoded.length, Math.max(0, bytes));
  if (end < encoded.length) while (end > 0 && (encoded[end] & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(encoded.subarray(0, end));
}

/**
 * #1711: bound the aggregate disposable output, never the provider envelope.
 * Conversation, arguments, structured results and unknown fields are lossless.
 * Runs after the image/output walker so its existing image policy is retained.
 */
export function boundSyncOutputs(parsed: unknown): boolean {
  const root = record(parsed);
  if (!root) return false;
  const fields: Array<{ owner: RecordValue; key: string }> = [];
  const add = (owner: RecordValue, key: string) => {
    if (typeof owner[key] === 'string' && !isStructuredSyncResult(owner[key])) fields.push({ owner, key });
  };
  const content = (owner: RecordValue, key: string) => {
    if (typeof owner[key] === 'string') add(owner, key);
    if (Array.isArray(owner[key])) for (const block of owner[key]) {
      const b = record(block);
      if (b?.type === 'text') add(b, 'text');
    }
  };
  const item = record(root.item) ?? record(record(root.params)?.item);
  if (item && !isInteractiveSyncItem(item)) {
    if (['commandExecution', 'command_execution'].includes(String(item.type))) {
      for (const key of ['aggregatedOutput', 'aggregated_output', 'output']) add(item, key);
    }
    if (['fileChange', 'file_change'].includes(String(item.type)) && Array.isArray(item.changes)) {
      for (const change of item.changes) { const c = record(change); if (c) add(c, 'diff'); }
    }
    if (['mcpToolCall', 'mcp_tool_call', 'commandExecution', 'command_execution'].includes(String(item.type))) {
      if (typeof item.result === 'string') add(item, 'result');
      const result = record(item.result);
      if (result) content(result, 'content');
    }
  }
  // OpenCode: { rawEvent: { properties: { part: { type: 'tool', tool, state: { output } } } } }
  const part = record(record(record(root.rawEvent)?.properties)?.part);
  const state = record(part?.state);
  if (part?.type === 'tool' && state && !isInteractiveSyncItem(part)) {
    add(state, 'output');
    const output = record(state.output);
    if (output) content(output, 'content');
  }
  const blocks = record(root.message)?.content;
  if (Array.isArray(blocks)) for (const block of blocks) {
    const b = record(block);
    if (b?.type === 'tool_result') content(b, 'content');
  }
  const total = fields.reduce((bytes, { owner, key }) => bytes + utf8ByteLen(owner[key] as string), 0);
  if (total <= 8 * 1024) return false;
  // Evenly distribute the output budget; preserve every field and its identity.
  const limit = Math.floor(8 * 1024 / fields.length);
  let changed = false;
  for (const { owner, key } of fields) {
    const text = owner[key] as string;
    if (utf8ByteLen(text) <= limit) continue;
    owner[key] = `${syncTextPrefix(text, Math.max(0, limit - 64))}\n[Output elided from mobile sync; view on desktop]`;
    changed = true;
  }
  return changed;
}
