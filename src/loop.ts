// The agentic loop: stream → collect assistant content → run tools → repeat.

import type {
  ChatMessage,
  ChatProvider,
  ContentBlock,
  ToolDef,
} from './types.js';
import type { Tool, ToolContext, ToolResult } from './tools.js';
import { currentTodos } from './tools.js';
import { renderTodos } from './todos.js';

export interface LoopOptions {
  provider: ChatProvider;
  model: string;
  maxTokens: number;
  tools: Tool[];
  system: string;
  cwd: string;
  maxTurns?: number;
  /** Decides whether a tool call may run; defaults to asking via REPL. */
  requestPermission: (tool: string, summary: string) => Promise<boolean>;
  onText?: (text: string) => void;
  onThinking?: (text: string) => void;
  onToolStart?: (name: string, summary?: string) => void;
  onToolResult?: (name: string, result: ToolResult) => void;
  onTodoChange?: (todos: ReturnType<typeof currentTodos>) => void;
}

export interface LoopResult {
  finalText: string;
  turns: number;
}

const DEFAULT_MAX_TURNS = 40;

function toToolDefs(tools: Tool[]): ToolDef[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    schema: t.schema,
  }));
}

export async function runAgentLoop(
  history: ChatMessage[],
  userMessage: string,
  opts: LoopOptions,
): Promise<LoopResult> {
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const ctx: ToolContext = {
    cwd: opts.cwd,
    requestPermission: (tool, summary) => opts.requestPermission(tool, summary),
  };

  history.push({ role: 'user', content: userMessage });

  let finalText = '';
  let turn = 0;

  while (turn < maxTurns) {
    turn++;

    let textBuf = '';
    let thinkBuf = '';
    const pending = new Map<
      string,
      { name: string; json: string; malformed: boolean }
    >();
    const blocks: ContentBlock[] = [];
    let streamError: unknown = null;

    const end = await opts.provider
      .stream(
        {
          model: opts.model,
          maxTokens: opts.maxTokens,
          system:
            opts.system +
            (currentTodos().length > 0
              ? `\n\nCurrent task list:\n${renderTodos(currentTodos())}`
              : ''),
          messages: history,
          tools: toToolDefs(opts.tools),
        },
        (ev) => {
          if (ev.kind === 'text') {
            textBuf += ev.text;
            opts.onText?.(ev.text);
          } else if (ev.kind === 'thinking') {
            thinkBuf += ev.text;
            opts.onThinking?.(ev.text);
          } else if (ev.kind === 'tool_use_start') {
            pending.set(ev.id, { name: ev.name, json: '', malformed: false });
          } else if (ev.kind === 'tool_input_delta') {
            const p = pending.get(ev.id);
            if (p) p.json += ev.partialJson;
          }
        },
      )
      .catch((e) => {
        streamError = e;
        return null;
      });

    if (streamError !== null || end === null)
      throw streamError ?? new Error('provider stream failed');

    if (thinkBuf) blocks.push({ type: 'thinking', text: thinkBuf });
    if (textBuf) {
      blocks.push({ type: 'text', text: textBuf });
      finalText = textBuf;
    }

    for (const [id, p] of pending) {
      let input: unknown = {};
      if (p.json.trim() !== '') {
        try {
          input = JSON.parse(p.json);
        } catch {
          input = { raw: p.json };
          p.malformed = true;
        }
      }
      if (!p.malformed) {
        blocks.push({ type: 'tool_use', id, name: p.name, input });
      } else {
        blocks.push({
          type: 'tool_result',
          tool_use_id: id,
          content: `Malformed tool input JSON for ${p.name}: ${p.json.slice(0, 300)}`,
          is_error: true,
        });
      }
    }

    if (blocks.length === 0) break; // empty response; stop to avoid looping

    history.push({ role: 'assistant', content: blocks });

    const toolUses = blocks.filter(
      (b): b is { type: 'tool_use'; id: string; name: string; input: unknown } =>
        b.type === 'tool_use',
    );
    if (toolUses.length === 0) break; // pure text answer; turn complete

    const results: ContentBlock[] = [];
    for (const tu of toolUses) {
      const tool = opts.tools.find((t) => t.name === tu.name);
      opts.onToolStart?.(tu.name, toolSummary(tu.input));
      let result: ToolResult;
      if (!tool) {
        result = {
          output: `Unknown tool: ${tu.name}. Available: ${opts.tools.map((t) => t.name).join(', ')}`,
          isError: true,
        };
      } else {
        try {
          result = await tool.run(
            (tu.input ?? {}) as Record<string, unknown>,
            ctx,
          );
        } catch (e) {
          result = { output: `Tool error: ${String(e)}`, isError: true };
        }
      }
      opts.onToolResult?.(tu.name, result);
      if (tu.name === 'todo_write') opts.onTodoChange?.(currentTodos());
      results.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: result.output,
        is_error: result.isError,
      });
    }
    history.push({ role: 'user', content: results });
  }

  return { finalText, turns: turn };
}

function toolSummary(input: unknown): string | undefined {
  const i = (input ?? {}) as Record<string, unknown>;
  if (typeof i['command'] === 'string') return i['command'].slice(0, 120);
  if (typeof i['file_path'] === 'string') return String(i['file_path']);
  return undefined;
}
