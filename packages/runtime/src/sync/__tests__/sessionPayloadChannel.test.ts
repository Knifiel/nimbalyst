// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { SessionPayloadChannel, type PreparedSessionMessage } from '../sessionPayloadChannel';

afterEach(() => vi.useRealTimers());
const row: PreparedSessionMessage = { id: 'm', sequence: 0, source: 'assistant', direction: 'output', createdAt: 1, encryptedContent: 'manifest', iv: 'A'.repeat(16), metadata: {}, projectionVersion: 1,
  payload: { transferId: 'a'.repeat(32), count: 1 }, parts: [{ messageId: 'm', transferId: 'a'.repeat(32), count: 1, index: 0, encryptedContent: 'cipher', iv: 'A'.repeat(16) }] };

it('waits for durable publication after all parts, binds compare-and-swap, and refuses early close', async () => {
  const sent: any[] = [];
  const channel = new SessionPayloadChannel({ send: (raw: string) => sent.push(JSON.parse(raw)) } as unknown as WebSocket);
  let complete = false;
  const publication = channel.publish(row).then(() => { complete = true; });
  await vi.waitFor(() => expect(sent.at(-1).type).toBe('getMessageProjection'));
  channel.receive({ type: 'messageProjectionState', messageId: 'm', revision: 7 });
  await vi.waitFor(() => expect(sent.at(-1).type).toBe('appendMessagePart'));
  expect(complete).toBe(false);
  channel.receive({ type: 'messagePartAck', transferId: 'a'.repeat(32), index: 0 });
  await vi.waitFor(() => expect(sent.at(-1)).toMatchObject({ type: 'appendMessage', expectedRevision: 7 }));
  expect(sent.at(-1).message.parts).toBeUndefined();
  expect(complete).toBe(false);
  channel.receive({ type: 'messageAppendAck', messageId: 'm', revision: 8 });
  await publication;
  expect(complete).toBe(true);
  const interrupted = channel.publish(row);
  const rejected = expect(interrupted).rejects.toThrow(/closed/);
  await Promise.resolve();
  channel.dispose();
  await rejected;
});

it('does not claim publication on old-server timeout or quota refusal', async () => {
  vi.useFakeTimers();
  const channel = new SessionPayloadChannel({ send: () => {} } as unknown as WebSocket);
  const first = expect(channel.publish(row)).rejects.toThrow(/timed out/);
  await vi.advanceTimersByTimeAsync(30_001); await first;
  const second = expect(channel.publish(row)).rejects.toThrow(/quota/);
  await Promise.resolve(); await Promise.resolve();
  channel.receive({ type: 'error', code: 'storage_limit_exceeded', message: 'quota exceeded' });
  await second;
  channel.dispose();
});

function harness() {
  const sent: any[] = [];
  const channel = new SessionPayloadChannel({ send: (raw: string) => sent.push(JSON.parse(raw)) } as unknown as WebSocket);
  return { sent, channel };
}
const inline: PreparedSessionMessage = { ...row, payload: undefined, parts: [] };

it('falls back to the legacy append when the server never sent the capability hello', async () => {
  const { sent, channel } = harness();
  const publication = channel.publish(inline);
  await vi.waitFor(() => expect(sent.at(-1).type).toBe('getMessageProjection'));
  channel.receive({ type: 'error', code: 'unknown_message_type', message: 'Unknown message type' });
  await publication;
  expect(sent.at(-1)).toEqual({ type: 'appendMessage', message: expect.not.objectContaining({ projectionVersion: 1 }) });
  expect(channel.acknowledged).toBe(false);
  await expect(channel.publish(row)).rejects.toThrow(/large transcript rows/);
});

it('takes one round trip for a new row and retries a replacement with the server revision', async () => {
  const { sent, channel } = harness();
  channel.receive({ type: 'sessionPayloadReady', version: 1 });
  const publication = channel.publish(inline);
  await vi.waitFor(() => expect(sent.at(-1).type).toBe('appendMessage'));
  expect(sent.at(-1).expectedRevision).toBeUndefined();
  expect(sent.map(m => m.type)).toEqual(['appendMessage']);
  // An unrelated refusal (e.g. metadata) must not fail the publication.
  channel.receive({ type: 'error', code: 'invalid_metadata', message: 'nope' });
  channel.receive({ type: 'error', code: 'invalid_projection', message: 'Transcript replacement requires an expected revision' });
  await vi.waitFor(() => expect(sent.at(-1).type).toBe('getMessageProjection'));
  channel.receive({ type: 'messageProjectionState', messageId: 'm', revision: 4 });
  await vi.waitFor(() => expect(sent.at(-1)).toMatchObject({ type: 'appendMessage', expectedRevision: 4 }));
  channel.receive({ type: 'messageAppendAck', messageId: 'm', revision: 5 });
  await publication;
  const refused = channel.publish(inline);
  await vi.waitFor(() => expect(sent.at(-1).type).toBe('appendMessage'));
  channel.receive({ type: 'error', code: 'message_too_large', message: 'too big' });
  await expect(refused).rejects.toMatchObject({ retryable: false, skippable: true });
  channel.dispose();
});
