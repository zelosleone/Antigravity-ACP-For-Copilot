import type { McpServer } from '@agentclientprotocol/sdk';
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type * as vscode from 'vscode';
import { peerProcess } from './processes.js';
import { METHOD_NOT_FOUND, type RpcMessage } from './rpc.js';

/** Antigravity shows these tools to the model as vscode_<name>. */
export const SERVER_NAME = 'vscode';

type Params = { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> };

// All the MCP the harness needs from a tool server.
const METHODS = new Map<string, (host: ToolHost | undefined, params: Params) => unknown>([
  ['initialize', (_host, params) => ({ protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: SERVER_NAME, version: '1.0.0' } })],
  ['tools/list', (host) => ({ tools: host?.tools() ?? [] })],
  ['tools/call', (host, params) => host?.call(params.name ?? '', params.arguments ?? {}) ?? errorResult('No chat has taken this session over yet.')],
  ['ping', () => ({})],
]);

export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface CallToolResult {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[];
  isError?: boolean;
}

export interface ToolHost {
  tools(): Tool[];
  call(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
}

/** A session's place on the bridge; the chat it serves attaches once it takes the session over. */
export interface BridgeEntry {
  server: McpServer;
  attach(host: ToolHost): void;
  /** The session's harness: the process that connects with its token, once it has. */
  harness(): Promise<number | undefined> | undefined;
  /** The server started a new harness for the session; it shows itself on its first connection. */
  replaced(): void;
  remove(): void;
}

interface Slot {
  host?: ToolHost;
  harness?: Promise<number | undefined>;
}

/**
 * Copilot's tools, served to Antigravity over MCP on a loopback port. Each session gets its own
 * bearer token, so a session only ever sees and calls its own chat's tools.
 */
export class Bridge implements vscode.Disposable {
  private readonly hosts = new Map<string, Slot>();
  private readonly server = createServer((request, response) => void this.handle(request, response).catch(() => fail(response)));
  private port?: Promise<number>;

  // Antigravity only connects at a session's first prompt, so a prepared session can wait unattached.
  async add(): Promise<BridgeEntry> {
    const port = await (this.port ??= this.listen());
    const token = randomBytes(24).toString('hex');
    const slot: Slot = {};
    this.hosts.set(token, slot);
    const server: McpServer = {
      type: 'http',
      name: SERVER_NAME,
      url: `http://127.0.0.1:${port}/mcp`,
      headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
    };
    return {
      server,
      attach: (host) => (slot.host = host),
      harness: () => slot.harness,
      replaced: () => (slot.harness = undefined),
      remove: () => this.hosts.delete(token),
    };
  }

  dispose(): void {
    this.server.close();
  }

  private listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        const address = this.server.address();
        if (address && typeof address === 'object') resolve(address.port);
        else reject(new Error('The tool bridge could not bind a loopback port.'));
      });
    });
  }

  // Stateless streamable HTTP, answered with plain JSON; notifications (no id) need no answer.
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.url !== '/mcp' || request.method !== 'POST') return void response.writeHead(405).end();
    const slot = this.hosts.get(request.headers.authorization?.replace(/^Bearer /, '') ?? '');
    if (!slot) return void response.writeHead(401).end();
    slot.harness ??= peerProcess(request.socket.remotePort);
    const message = JSON.parse(await body(request)) as RpcMessage;
    if (message.id === undefined) return void response.writeHead(202).end();
    const reply = await answer(slot.host, message);
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...reply }));
  }
}

async function answer(host: ToolHost | undefined, { method, params }: RpcMessage): Promise<object> {
  const run = METHODS.get(method ?? '');
  if (!run) return { error: { code: METHOD_NOT_FOUND, message: `Method not found: ${method}` } };
  return { result: await run(host, (params ?? {}) as Params) };
}

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function fail(response: ServerResponse): void {
  if (!response.headersSent) response.writeHead(500);
  response.end();
}

/** Copilot's tool as an MCP tool. Copilot names and schemas pass through unchanged. */
export function toMcpTool(tool: vscode.LanguageModelChatTool): Tool {
  const schema = (tool.inputSchema ?? {}) as Record<string, unknown>;
  return { name: tool.name, description: tool.description, inputSchema: { ...schema, type: 'object' } };
}

export function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}
