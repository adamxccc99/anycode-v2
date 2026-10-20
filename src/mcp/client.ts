// MCP (Model Context Protocol) client — JSON-RPC 2.0 over stdio subprocess.
// Speaks the minimal protocol subset needed: initialize, tools/list, tools/call.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface McpServerConfig {
  /** Executable to spawn, e.g. "npx", "docker", "node" or an absolute path. */
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpServerInfo {
  name: string;
  serverVersion?: string;
}

type JsonRpcResponse = { id: number; result?: unknown; error?: { code: number; message: string } };

export class McpClientError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
    this.name = 'McpClientError';
  }
}

export class McpClient {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<number, (r: JsonRpcResponse) => void>();
  private notifications: ((method: string, params: unknown) => void)[] = [];
  private lineBuf = '';
  info: McpServerInfo | null = null;
  tools: McpTool[] = [];

  constructor(
    readonly serverName: string,
    private readonly config: McpServerConfig,
  ) {}

  async connect(timeoutMs = 15000): Promise<McpServerInfo> {
    if (this.child) return this.info!;
    void timeoutMs;
    this.child = spawn(this.config.command, this.config.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...(this.config.env ?? {}),
      },
      cwd: this.config.cwd ?? process.cwd(),
    });

    const rl = createInterface({ input: this.child.stdout });
    rl.on('line', (line) => this.handleLine(line));
    this.child.stderr.on('data', (d: Buffer) => {
      // Server stderr is diagnostics; keep out of protocol but flag loudly.
      const s = d.toString().trim();
      if (s && process.env['ANYCODE_MCP_DEBUG']) process.stderr.write(`[mcp ${this.serverName}] ${s}\n`);
    });
    this.child.on('exit', (code) => {
      // Reject pending requests so callers fail fast instead of hanging.
      const err = new McpClientError(
        `MCP server "${this.serverName}" exited (code ${code ?? 'signal'})`,
      );
      for (const [id, res] of this.pending) {
        res({ id, error: { code: -32603, message: err.message } });
        this.pending.delete(id);
      }
      this.child = undefined;
    });

    const result = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      clientInfo: { name: 'anycode', version: '0.2.0' },
    });
    const r = result as { serverInfo?: { name?: string; version?: string } } | undefined;
    this.info = {
      name: r?.serverInfo?.name ?? this.serverName,
      serverVersion: r?.serverInfo?.version,
    };
    // post-initialize notification
    this.notify('notifications/initialized', {});
    await this.refreshTools();
    return this.info;
  }

  onNotification(fn: (method: string, params: unknown) => void): void {
    this.notifications.push(fn);
  }

  private handleLine(line: string): void {
    const raw = line.trim();
    if (!raw) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof msg['id'] === 'number' && (msg['result'] !== undefined || msg['error'] !== undefined)) {
      const resolver = this.pending.get(msg['id'] as number);
      if (resolver) {
        this.pending.delete(msg['id'] as number);
        resolver(msg as JsonRpcResponse);
      }
    } else if (typeof msg['method'] === 'string') {
      for (const fn of this.notifications) fn(msg['method'] as string, msg['params']);
    }
  }

  private request(method: string, params: unknown, timeoutMs = 30000): Promise<unknown> {
    if (!this.child) return Promise.reject(new McpClientError('not connected'));
    const id = this.nextId++;
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new McpClientError(`timeout waiting for ${method} after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      this.pending.set(id, (r) => {
        clearTimeout(timer);
        if (r.error) reject(new McpClientError(r.error.message, r.error.code));
        else resolve(r.result);
      });
      try {
        this.child!.stdin.write(msg + '\n');
      } catch (e) {
        clearTimeout(timer);
        reject(new McpClientError(`write failed: ${String(e)}`));
      }
    });
  }

  private notify(method: string, params: unknown): void {
    if (!this.child) return;
    try {
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    } catch {
      /* server died mid-notify; next request will surface it */
    }
  }

  async refreshTools(): Promise<McpTool[]> {
    const result = await this.request('tools/list', {}, 30000);
    const r = result as { tools?: McpTool[] } | undefined;
    this.tools = Array.isArray(r?.tools) ? r.tools : [];
    return this.tools;
  }

  async callTool(
    toolName: string,
    args: unknown,
    timeoutMs = 60000,
  ): Promise<{ output: string; isError: boolean }> {
    const result = await this.request(
      'tools/call',
      { name: toolName, arguments: args ?? {} },
      timeoutMs,
    );
    const r = result as {
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
      structuredContent?: unknown;
    };
    const parts: string[] = [];
    for (const c of r?.content ?? []) {
      if (typeof c?.text === 'string' && c.type !== 'image') parts.push(c.text);
    }
    const out =
      parts.join('\n') ||
      (r?.structuredContent ? JSON.stringify(r.structuredContent, null, 2) : '(empty result)');
    return { output: r?.isError ? `[MCP error]\n${out}` : out, isError: r?.isError === true };
  }

  close(): void {
    if (!this.child) return;
    try {
      this.child.stdin.end();
      this.child.kill();
    } catch {
      /* already gone */
    }
    this.child = undefined;
  }

  get connected(): boolean {
    return this.child !== undefined;
  }
}
