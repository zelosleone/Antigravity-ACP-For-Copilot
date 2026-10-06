import type { McpServer } from '@agentclientprotocol/sdk';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type * as vscode from 'vscode';

/** Antigravity shows these tools to the model as vscode_<name>. */
export const SERVER_NAME = 'vscode';

export interface ToolHost {
  tools(): Tool[];
  call(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
}

/** A session's place on the bridge; the chat it serves attaches once it takes the session over. */
export interface BridgeEntry {
  server: McpServer;
  attach(host: ToolHost): void;
  remove(): void;
}

/**
 * Copilot's tools, served to Antigravity over MCP on a loopback port. Each session gets its own
 * bearer token, so a session only ever sees and calls its own chat's tools.
 */
export class Bridge implements vscode.Disposable {
  private readonly hosts = new Map<string, { host?: ToolHost }>();
  private readonly server = createServer((request, response) => void this.handle(request, response).catch(() => fail(response)));
  private port?: Promise<number>;

  // Antigravity only connects at a session's first prompt, so a prepared session can wait unattached.
  async add(): Promise<BridgeEntry> {
    const port = await (this.port ??= this.listen());
    const token = randomBytes(24).toString('hex');
    const slot: { host?: ToolHost } = {};
    this.hosts.set(token, slot);
    const server: McpServer = {
      type: 'http',
      name: SERVER_NAME,
      url: `http://127.0.0.1:${port}/mcp`,
      headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
    };
    return { server, attach: (host) => (slot.host = host), remove: () => this.hosts.delete(token) };
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

  // Stateless streamable HTTP: one short-lived MCP server per request.
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.url !== '/mcp' || request.method !== 'POST') return void response.writeHead(405).end();
    const slot = this.hosts.get(request.headers.authorization?.replace(/^Bearer /, '') ?? '');
    if (!slot) return void response.writeHead(401).end();
    const mcp = new Server({ name: SERVER_NAME, version: '1.0.0' }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, () => ({ tools: slot.host?.tools() ?? [] }));
    mcp.setRequestHandler(CallToolRequestSchema, (call) => slot.host?.call(call.params.name, call.params.arguments ?? {}) ?? errorResult('No chat has taken this session over yet.'));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    response.once('close', () => void transport.close().then(() => mcp.close()));
    await mcp.connect(transport);
    await transport.handleRequest(request, response);
  }
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
