// OpenAI-compatible /chat/completions provider. Covers OpenAI, Groq, Together,
// OpenRouter, and local servers: Ollama (/v1), llama.cpp (server), LM Studio,
// vLLM. Tool calling is passed through when the model supports it.

import type {
  ChatMessage,
  ChatProvider,
  ChatRequest,
  ContentBlock,
  ProviderEvent,
  StreamEnd,
  ToolDef,
} from '../types.js';
import { parseSse } from './sse.js';

interface DeltaToolCall {
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

function toOpenAiMessages(req: ChatRequest): unknown[] {
  const out: unknown[] = [{ role: 'system', content: req.system }];
  for (const m of req.messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const blocks = m.content as ContentBlock[];
    const text = blocks
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    const toolUses = blocks.filter(
      (b): b is { type: 'tool_use'; id: string; name: string; input: unknown } =>
        b.type === 'tool_use',
    );
    const toolResults = blocks.filter(
      (b): b is {
        type: 'tool_result';
        tool_use_id: string;
        content: string;
        is_error?: boolean;
      } => b.type === 'tool_result',
    );

    const msg: Record<string, unknown> & { tool_calls?: unknown[] } = {
      role: m.role,
    };
    if (toolUses.length > 0) {
      msg.tool_calls = toolUses.map((t) => ({
        id: t.id,
        type: 'function',
        function: { name: t.name, arguments: JSON.stringify(t.input) },
      }));
      if (text) msg.content = text;
      // Some servers reject assistant messages with empty content + tool_calls
      if (!text && msg.tool_calls.length > 0) delete msg.content;
    } else {
      msg.content = text;
    }
    out.push(msg);

    for (const tr of toolResults) {
      out.push({
        role: 'tool',
        tool_call_id: tr.tool_use_id,
        content: tr.content,
      });
    }
  }
  return out;
}

function toOpenAiTools(tools: ToolDef[]): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.schema },
  }));
}

export class OpenAiProvider implements ChatProvider {
  readonly name = 'openai';
  private started = new Set<string>();
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
  ) {}

  async stream(
    req: ChatRequest,
    onEvent: (ev: ProviderEvent) => void,
  ): Promise<StreamEnd> {
    const url = `${this.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const body: Record<string, unknown> = {
      model: req.model,
      stream: true,
      stream_options: { include_usage: true },
      messages: toOpenAiMessages(req),
      max_tokens: req.maxTokens,
    };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.tools.length > 0) {
      body.tools = toOpenAiTools(req.tools);
      body.tool_choice = 'auto';
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      throw new Error(`API error ${res.status} from ${url}: ${detail.slice(0, 2000)}`);
    }

    let stopReason: string | null = null;
    let usage: StreamEnd['usage'] = { input_tokens: 0, output_tokens: 0 };

    // OpenAI tool-call deltas arrive indexed without stable ids on first chunk.
    const partial = new Map<
      number,
      { id: string; name: string; args: string }
    >();

    for await (const sse of parseSse(res.body)) {
      let chunk: Record<string, unknown>;
      try {
        chunk = JSON.parse(sse.data) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (chunk.usage) {
        const u = chunk.usage as {
          prompt_tokens?: number;
          completion_tokens?: number;
        };
        usage = {
          input_tokens: u.prompt_tokens ?? usage.input_tokens,
          output_tokens: u.completion_tokens ?? usage.output_tokens,
        };
      }
      const choices = chunk.choices as
        | Array<{
            delta?: {
              content?: string | null;
              reasoning?: string | null;
              tool_calls?: DeltaToolCall[];
            };
            finish_reason?: string | null;
          }>
        | undefined;
      const choice = choices?.[0];
      if (!choice) continue;

      const delta = choice.delta;
      if (delta?.reasoning) onEvent({ kind: 'thinking', text: delta.reasoning });
      if (delta?.content) onEvent({ kind: 'text', text: delta.content });

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          let slot = partial.get(tc.index);
          if (!slot) {
            slot = { id: tc.id ?? '', name: tc.function?.name ?? '', args: '' };
            partial.set(tc.index, slot);
          }
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name = tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
          if (slot.id && slot.name) {
            if (!this.started.has(slot.id)) {
              this.started.add(slot.id);
              onEvent({ kind: 'tool_use_start', id: slot.id, name: slot.name });
            }
            if (tc.function?.arguments) {
              onEvent({
                kind: 'tool_input_delta',
                id: slot.id,
                partialJson: tc.function.arguments,
              });
            }
          }
        }
      }
      if (choice.finish_reason) stopReason = choice.finish_reason;
    }
    return { stopReason, usage };
  }
}
