// MCP registry: discovers servers from mcp.json, connects lazily, adapts
// each server's tools into loop Tools named mcp__<server>__<tool>.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { McpClient, McpClientError } from './client.js';
import type { Tool, ToolContext, ToolResult } from '../tools.js';

export interface McpConfigs {
  mcpServers: Record<string, import('./client.js').McpServerConfig>;
  /** Tools disabled per server, e.g. { github: ["list_pulls"] } */
  disabledTools?: Record<string, string[]>;
}

const CONFIG_SKIP = new Set(['node_modules', 'dist', 'dist-test', '.git', 'src']);

export function loadMcpConfigs(cwd = process.cwd()): McpConfigs {
  const candidates: string[] = [
    join(cwd, '.mcp.json'),
    join(cwd, 'mcp.json'),
    join(cwd, 'anycode.config.json'),
    join(homedir(), '.anycode', 'mcp.json'),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const raw = readFileSync(p, 'utf8');
      const parsed = JSON.parse(raw) as Partial<McpConfigs> & { mcpServers?: unknown };
      if (parsed.mcpServers && typeof parsed.mcpServers === 'object') {
        return {
          mcpServers: parsed.mcpServers as McpConfigs['mcpServers'],
          disabledTools: parsed.disabledTools,
        };
      }
    } catch {
      continue;
    }
  }
  return { mcpServers: {} };
}

export interface McpRegistryOptions {
  configs: McpConfigs;
  /** Tools disabled per server. */
  disabledTools?: Record<string, string[]>;
}

export class McpRegistry {
  readonly clients = new Map<string, McpClient>();
  private readonly disabled: Record<string, string[]>;
  private readonly configs: McpConfigs;

  constructor(options: McpRegistryOptions) {
    this.configs = options.configs;
    this.disabled = options.disabledTools ?? options.configs.disabledTools ?? {};
  }

  /** Tools exposed per connected server. */
  isDisabled(server: string, tool: string): boolean {
    const list = this.disabled[server];
    return Array.isArray(list) && list.includes(tool);
  }

  async connect(serverNames?: string[]): Promise<void> {
    const wanted =
      serverNames && serverNames.length > 0 ? serverNames : [...Object.keys(this.configs.mcpServers)];
    for (const name of wanted) {
      if (this.clients.has(name)) continue;
      const cfg = this.configs.mcpServers[name];
      if (!cfg) throw new McpClientError(`no MCP server config for "${name}"`);
      const client = new McpClient(name, cfg);
      await client.connect();
      this.clients.set(name, client);
    }
  }

  autoToolName(server: string, tool: string): string {
    return `mcp__${server}__${tool}`;
  }

  /** Build Tool wrappers for all connected (or all configured) servers. */
  async buildTools(options?: {
    serverNames?: string[];
    onList?: (server: string, tools: string[]) => void;
  }): Promise<Tool[]> {
    await this.connect(options?.serverNames);
    const out: Tool[] = [];
    for (const [serverName, client] of this.clients) {
      const tools = client.tools.filter((t) => !this.isDisabled(serverName, t.name));
      options?.onList?.(serverName, tools.map((t) => t.name));
      for (const t of tools) {
        out.push({
          name: this.autoToolName(serverName, t.name),
          description:
            (t.description ?? 'MCP tool') + ` (from MCP server "${serverName}")`,
          schema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object' },
          safe: false, // conservative default: external side effects are untrusted
          safeProxy: false,
          run: async (input, ctx) => {
            // MCP tool args arrive as the raw input object; forward as-is.
            return await this.callWithCtx(serverName, t.name, input, ctx);
          },
        } as Tool & { safeProxy?: boolean });
      }
    }
    return out;
  }

  async callWithCtx(
    server: string,
    tool: string,
    input: Record<string, unknown>,
    _ctx?: ToolContext,
  ): Promise<ToolResult> {
    const client = this.clients.get(server);
    if (!client || !client.connected) {
      // Lazy reconnect once
      try {
        await this.connect([server]);
      } catch (e) {
        return { output: `MCP: could not reconnect "${server}": ${String(e)}`, isError: true };
      }
    }
    const c = this.clients.get(server)!;
    try {
      const { output, isError } = await c.callTool(tool, input);
      return { output, isError };
    } catch (e) {
      return {
        output: e instanceof McpClientError ? e.message : `MCP call failed: ${String(e)}`,
        isError: true,
      };
    }
  }

  closeAll(): void {
    for (const c of this.clients.values()) c.close();
    this.clients.clear();
  }

  listSummary(): string[] {
    const lines: string[] = [];
    for (const [name, client] of this.clients) {
      const tools = client.tools.filter((t) => !this.isDisabled(name, t.name));
      lines.push(
        `${name} (${client.connected ? 'connected' : 'disconnected'}) · ${client.info?.name ?? '?'}${client.info?.serverVersion ? ` v${client.info.serverVersion}` : ''} · tools: ${tools.map((t) => t.name).join(', ') || '(none)'}`,
      );
    }
    return lines;
  }
}

const SKIP = CONFIG_SKIP;
void SKIP;
