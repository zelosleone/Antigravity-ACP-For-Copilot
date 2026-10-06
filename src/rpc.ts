import type { ChildProcess } from 'node:child_process';

export const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

export interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

/** An error the other side answered with. */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

type Handler = (method: string, params: unknown) => unknown;

/**
 * JSON-RPC 2.0 over a child process's stdio, one message per line: ACP's transport. Small enough that
 * the SDK (and the validation libraries it loads, over 1 MB) stays out of the editor's memory.
 */
export class Connection {
  private lastId = 0;
  private buffer = '';
  private closed?: Error;
  private readonly calls = new Map<RpcMessage['id'], { resolve(result: unknown): void; reject(error: Error): void }>();

  constructor(
    private readonly child: ChildProcess,
    private readonly handle: Handler,
  ) {
    // A write racing the process's exit fails here instead of taking the extension host down.
    child.stdin?.on('error', () => undefined);
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => this.read(chunk));
  }

  request<T>(method: string, params: object): Promise<T> {
    if (this.closed) return Promise.reject(this.closed);
    const id = ++this.lastId;
    return new Promise<T>((resolve, reject) => {
      this.calls.set(id, { resolve: (result) => resolve(result as T), reject });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params: object): void {
    this.write({ method, params });
  }

  /** Fails every call still waiting, once the process is gone. */
  close(error: Error): void {
    this.closed ??= error;
    for (const call of this.calls.values()) call.reject(error);
    this.calls.clear();
  }

  private read(chunk: string): void {
    const lines = (this.buffer + chunk).split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) this.receive(parse(line));
  }

  private receive(message: RpcMessage | undefined): void {
    if (message?.method) return void this.answer(message);
    const call = this.calls.get(message?.id);
    if (!call || !message) return;
    this.calls.delete(message.id);
    if (message.error) call.reject(new RpcError(message.error.code, message.error.message));
    else call.resolve(message.result);
  }

  // Requests get an answer; notifications (no id) don't.
  private async answer({ id, method = '', params }: RpcMessage): Promise<void> {
    try {
      const result = await this.handle(method, params);
      if (id !== undefined) this.write({ id, result: result ?? null });
    } catch (error) {
      const code = error instanceof RpcError ? error.code : INTERNAL_ERROR;
      if (id !== undefined) this.write({ id, error: { code, message: error instanceof Error ? error.message : String(error) } });
    }
  }

  private write(message: RpcMessage): void {
    this.child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }
}

function parse(line: string): RpcMessage | undefined {
  try {
    return JSON.parse(line) as RpcMessage;
  } catch {
    return undefined;
  }
}
