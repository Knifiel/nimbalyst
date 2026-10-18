/**
 * `nim mcp`: an MCP server over stdio. Newline-delimited JSON-RPC, no SDK, to
 * keep an `npx` install small; the plugin's `session-inputs` server
 * (packages/extensions/knowledge/src/sessionInputs/server.ts) has the same shape.
 *
 * stdout carries protocol messages and nothing else. A stray line there is a
 * parse error on the client's side, so all logging goes to stderr.
 */
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { TeamScopeRefusal, textResult, type ToolMap } from './toolMap.js';

const DEFAULT_PROTOCOL = '2025-06-18';

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: unknown;
  params?: any;
}

export interface ServerInfo {
  name: string;
  version: string;
}

const rpcError = (id: JsonRpcId, code: number, message: string) => ({
  jsonrpc: '2.0',
  id,
  error: { code, message },
});

/** One JSON-RPC message in, the response out (null for a notification). */
export async function handleMessage(
  message: unknown,
  tools: ToolMap,
  serverInfo: ServerInfo,
  takeNotice?: () => string | null,
  instructions?: string,
): Promise<object | null> {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return rpcError(null, -32600, 'Invalid request');
  }
  const request = message as JsonRpcRequest;
  // Notifications (initialized, cancelled, ...) carry no id and get no answer.
  if (request.id === undefined) return null;
  const id = request.id;
  if (typeof request.method !== 'string') return rpcError(id, -32600, 'Invalid request');
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id, result });

  switch (request.method) {
    case 'initialize':
      return reply({
        protocolVersion:
          typeof request.params?.protocolVersion === 'string' ? request.params.protocolVersion : DEFAULT_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo,
        ...(instructions ? { instructions } : {}),
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: tools.definitions() });
    case 'tools/call': {
      const name = request.params?.name;
      const tool = typeof name === 'string' ? tools.get(name) : undefined;
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${String(name)}`);
      const args = request.params?.arguments;
      try {
        const result = await tool.call(args && typeof args === 'object' ? args : {});
        const notice = result.isError ? null : takeNotice?.();
        return reply(notice ? { ...result, content: [...result.content, { type: 'text', text: notice }] } : result);
      } catch (err) {
        // Tool failures are results the agent reads, not protocol errors.
        if (!(err instanceof TeamScopeRefusal)) {
          process.stderr.write(`nim mcp: ${String(name)} failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
        }
        return reply(textResult(err instanceof Error ? err.message : String(err), true));
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${request.method}`);
  }
}

export interface StdioServerOptions {
  tools: ToolMap;
  serverInfo: ServerInfo;
  /** A one-time notice (see updateCheck.ts) appended to a successful tool result. */
  takeNotice?: () => string | null;
  /** Sent in `initialize`; hosts put it in the agent's system prompt. */
  instructions?: string;
  input?: Readable;
  output?: Writable;
}

/**
 * Serve until stdin closes. Messages are handled one at a time, in order, so a
 * write never races the read that follows it in the same session.
 */
export function runStdioServer(options: StdioServerOptions): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const send = (response: object) => output.write(`${JSON.stringify(response)}\n`);
  let queue = Promise.resolve();

  return new Promise((resolve) => {
    const lines = createInterface({ input, crlfDelay: Infinity });
    lines.on('line', (line) => {
      if (!line.trim()) return;
      queue = queue.then(async () => {
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          send(rpcError(null, -32700, 'Parse error'));
          return;
        }
        const response = await handleMessage(message, options.tools, options.serverInfo, options.takeNotice, options.instructions);
        if (response) send(response);
      });
    });
    lines.on('close', () => {
      void queue.then(() => resolve());
    });
  });
}
