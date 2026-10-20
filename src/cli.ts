// anycode CLI: one-shot (-p) or interactive REPL, any provider.

import { createInterface } from 'node:readline';
import type { Interface as RlInterface } from 'node:readline';
import { cyan, dim, yellow, red, green } from './ui.js';
import {
  resolveConfig,
  makeProvider,
  type CliFlags,
  type ResolvedConfig,
} from './config.js';
import { BUILTIN_TOOLS } from './tools.js';
import { SYSTEM_PROMPT, todoLines } from './todos.js';
import { runAgentLoop } from './loop.js';
import { loadMcpConfigs, McpRegistry } from './mcp/index.js';
import { SKILLS_TOOL, listSkills, activeSkillContent, activeSkillNames, activateSkill } from './skills.js';
import type { Tool } from './tools.js';
import type { ChatMessage } from './types.js';

interface ParsedFlags extends CliFlags {
  prompt?: string;
  oneShot: boolean;
  yes: boolean;
  mcpServers?: string[];
  skillsDirs?: string[];
}

function usage(): string {
  return `anycode — agentic coding with any model

Usage:
  anycode [flags] ["initial prompt"]
  anycode -p "one-shot prompt"

Model selection:
  --provider anthropic|openai   Provider kind (default: auto)
  --model NAME                  e.g. claude-sonnet-4-5, qwen2.5-coder:7b
  --base-url URL                e.g. http://localhost:11434/v1 (Ollama)
  --profile NAME                Profile from anycode.config.json / ~/.anycode/config.json

Keys: env by default (ANTHROPIC_API_KEY / OPENAI_API_KEY); profiles may set
apiKeyEnv or apiKey. The openai provider covers OpenAI, Groq, Together,
OpenRouter, and local servers: Ollama, llama.cpp, LM Studio, vLLM.

Extensions:
  --mcp NAME...             Connect MCP servers from mcp.json (default: all)
  --skills-dir DIR          Extra directory for skills (in addition to ./skills
                            and ~/.anycode/skills); load from mcp.json etc.

Skills: create skills/<name>.md with instructions; the agent can load them via
use_skill, or with /skill NAME. /skills lists them.

MCP: mcp.json (project) or ~/.anycode/mcp.json:
  { "mcpServers": {
      "github":       { "command": "docker", "args": ["run", "-i", "--rm",
                                    "-e", "GITHUB_PERSONAL_ACCESS_TOKEN",
                                    "ghcr.io/github/github-mcp-server"] },
      "gdrive":       { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-gdrive"] },
      "roblox-studio":{ "command": "node", "args": ["path/to/roblox-studio-mcp/server.js"] }
  } }
Run anycode and the tools appear as mcp__<server>__<tool>; /mcp lists them.

Other:
  --yes              Auto-approve tool calls
  --max-tokens N     Output budget per turn
  -p "prompt"        One-shot mode
  --help             This message

Config file (./anycode.config.json or ~/.anycode/config.json):
  { "profiles": { "local": { "provider": "openai",
                             "baseUrl": "http://localhost:11434/v1",
                             "model": "qwen2.5-coder:7b" } } }`;
}

function fail(msg: string): never {
  process.stderr.write(red(`error: ${msg}\n`) + '\n' + usage() + '\n');
  process.exit(2);
}

export function parseArgs(argv: string[]): ParsedFlags {
  const flags: ParsedFlags = { oneShot: false, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      process.stdout.write(usage() + '\n');
      process.exit(0);
    } else if (a === '-p' || a === '--prompt') {
      flags.prompt = argv[++i];
      flags.oneShot = true;
    } else if (a === '--yes' || a === '-y') {
      flags.yes = true;
    } else if (a === '--provider') {
      const v = argv[++i];
      if (v !== 'anthropic' && v !== 'openai') {
        fail(`--provider must be "anthropic" or "openai", got ${v}`);
      }
      flags.provider = v;
    } else if (a === '--model') {
      flags.model = argv[++i];
    } else if (a === '--base-url') {
      flags.baseUrl = argv[++i];
    } else if (a === '--profile') {
      flags.profile = argv[++i];
    } else if (a === '--max-tokens') {
      flags.maxTokens = Number(argv[++i]);
    } else if (a === '--api-key-env') {
      flags.apiKeyEnv = argv[++i];
    } else if (a === '--mcp') {
      flags.mcpServers = (argv[++i] ?? '').split(',').filter(Boolean);
    } else if (a === '--skills-dir') {
      flags.skillsDirs = [...(flags.skillsDirs ?? []), argv[++i] ?? ''];
    } else {
      flags.prompt = a; // positional initial prompt (interactive mode)
    }
  }
  return flags;
}

const AUTO_YES = '__autoYes';
const history: ChatMessage[] = [];
const mcpRegistry = new McpRegistry({ configs: loadMcpConfigs() });
let mcpTools: Tool[] = [];

async function buildToolset(flags: ParsedFlags): Promise<Tool[]> {
  let mcp: Tool[] = [];
  try {
    mcp = await mcpRegistry.buildTools({ serverNames: flags.mcpServers });
  } catch (e) {
    process.stdout.write(red(`MCP: ${(e as Error).message}\n`));
  }
  mcpTools = mcp;
  return [...BUILTIN_TOOLS, SKILLS_TOOL, ...mcp];
}

async function askPermission(
  rl: RlInterface | null,
  tool: string,
  summary: string,
  autoYes: boolean,
): Promise<boolean> {
  if (autoYes) return true;
  if (!rl) return false;
  return await new Promise<boolean>((resolve) => {
    rl.pause();
    rl.question(
      yellow(`${tool}: ${summary}\n  allow? [y/N/a(ll)] `),
      (answer: string) => {
        rl.resume();
        const a = answer.trim().toLowerCase();
        if (a === 'a' || a === 'all') {
          (rl as unknown as Record<string, boolean>)[AUTO_YES] = true;
          resolve(true);
        } else {
          resolve(a === 'y' || a === 'yes' || a === '');
        }
      },
    );
  });
}

async function runTurn(
  rl: RlInterface | null,
  flags: ParsedFlags,
  userMessage: string,
  cfg: ResolvedConfig,
): Promise<string> {
  const provider = makeProvider(cfg);
  const autoYes =
    flags.yes ||
    (rl as unknown as Record<string, unknown> | null)?.[AUTO_YES] === true;

  let spin = 0;
  const frames = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
  const tick = setInterval(() => {
    process.stdout.write(dim(`\r${frames[spin++ % frames.length]} thinking…`));
  }, 100);
  const clearSpin = () => {
    clearInterval(tick);
    process.stdout.clearLine?.(0);
    process.stdout.cursorTo?.(0);
  };

  try {
    const r = await runAgentLoop(history, userMessage, {
      provider,
      model: cfg.model,
      maxTokens: cfg.maxTokens,
      tools: [...BUILTIN_TOOLS, SKILLS_TOOL, ...mcpTools],
      system:
        SYSTEM_PROMPT +
        (activeSkillContent()
          ? `\n\nActive skills:\n${activeSkillContent()}`
          : ''),
      cwd: process.cwd(),
      requestPermission: (tool, summary) =>
        askPermission(rl, tool, summary, autoYes),
      onThinking: (t: string) => process.stdout.write(dim(t)),
      onText: (t: string) => {
        clearSpin();
        process.stdout.write(t);
      },
      onToolStart: (_name: string, summary?: string) => {
        clearSpin();
        if (summary) process.stdout.write(`${dim('● ' + summary)}\n`);
      },
      onToolResult: (_name: string, result: { isError?: boolean; output: string }) => {
        if (result.isError) {
          process.stdout.write(red(`  !! ${result.output.slice(0, 400)}\n`));
        }
      },
      onTodoChange: () => {
        const lines = todoLines();
        if (lines.length > 0) process.stdout.write(dim(lines.join('\n') + '\n'));
      },
    });
    clearSpin();
    return r.finalText;
  } catch (e) {
    clearSpin();
    throw e;
  }
}

export async function main(argv: string[]): Promise<void> {
  const flags = parseArgs(argv);
  let cfg: ResolvedConfig;
  try {
    cfg = resolveConfig(flags);
  } catch (e) {
    process.stderr.write(red(`${(e as Error).message}\n`));
    process.exit(2);
  }
  process.stdout.write(
    `${green('anycode')} ${dim(`· ${cfg.provider} · ${cfg.model}`)}\n`,
  );
  // Set up MCP early so /mcp and the tool set are ready for the first turn.
  await buildToolset(flags);

  if (flags.oneShot && flags.prompt) {
    try {
      const out = await runTurn(null, flags, flags.prompt, cfg);
      process.stdout.write('\n');
      process.exit(0);
      void out;
    } catch (e) {
      process.stderr.write(red(`${(e as Error).message}\n`));
      process.exit(1);
    }
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: green('› '),
  });
  rl.prompt();

  rl.on('line', async (line: string) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }
    if (input === '/quit' || input === '/exit') {
      rl.close();
      process.exit(0);
    }
    if (input.startsWith('/')) {
      const parts = input.split(/\s+/);
      if (parts[0] === '/model') {
        if (parts[1]) cfg = { ...cfg, model: String(parts[1]) };
        process.stdout.write(`model: ${cfg.model}\n`);
      } else if (parts[0] === '/tools') {
        const names = [...BUILTIN_TOOLS.map((t) => t.name), 'use_skill', ...mcpTools.map((t) => t.name)];
        process.stdout.write(names.join(', ') + '\n');
      } else if (parts[0] === '/mcp') {
        const lines = mcpRegistry.listSummary();
        process.stdout.write(lines.length > 0 ? lines.join('\n') + '\n' : dim('no MCP servers connected\n'));
      } else if (parts[0] === '/skills') {
        const skills = listSkills();
        process.stdout.write(
          skills.length > 0
            ? skills.map((s) => `${s.name} ${dim(`(${s.source}) ${s.title}`)}`).join('\n') + '\n'
            : 'no skills found (create skills/<name>.md)\n',
        );
      } else if (parts[0] === '/skill') {
        if (parts[1]) {
          const s = activateSkill(parts[1]);
          process.stdout.write(s ? green(`skill active: ${s.name}\n`) : red(`skill not found: ${parts[1]}\n`));
        } else {
          const active = activeSkillNames();
          process.stdout.write(active.length > 0 ? active.join(', ') + '\n' : dim('no active skills\n'));
        }
      } else if (parts[0] === '/help') {
        process.stdout.write('  /model NAME · /tools · /mcp · /skills · /skill NAME · /quit\n');
      } else {
        process.stdout.write(dim(`unknown command ${input}\n`));
      }
      rl.prompt();
      return;
    }
    try {
      await runTurn(rl, flags, input, cfg);
      process.stdout.write('\n');
    } catch (e) {
      process.stdout.write(red(`${(e as Error).message}\n`));
    }
    rl.prompt();
  }).on('close', () => {
    process.exit(0);
  });
}

if (process.argv[1] && process.argv[1].endsWith('cli.js')) {
  void main(process.argv.slice(2));
}
