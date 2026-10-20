// Anthropic Messages API provider (streaming, tool use).

import type {
  ChatMessage,
  ChatProvider,
  ChatRequest,
  ContentBlock,
  ProviderEvent,
  StreamEnd,
} from '../types.js';
import { parseSse } from './sse.js';

const ANTHROPIC_VERSION = '2023-06-01';

interface AnthropicBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

function toAnthropicMessages(msgs: ChatMessage[]): unknown[] {
  return msgs.map((m) => ({
    role: m.role,
    content:
      typeof m.content === 'string'
        ? m.content
        : (m.content as ContentBlock[])
            // thinking is not replayed on later turns (valid per Messages API)
            .filter((b) => b.type !== 'thinking')
            .map((b) => {
              if (b.type === 'text') return { type: 'text', text: b.text };
              if (b.type === 'tool_use')
                return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
              // tool_result blocks always live in a user message
              return {
                type: 'tool_result',
                tool_use_id: b.tool_use_id,
                content: b.content,
                ...(b.is_error ? { is_error: true } : {}),
              };
            }),
  }));
}

export class AnthropicProvider implements ChatProvider {
  readonly name = 'anthropic';
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = 'https://api.anthropic.com',
  ) {}

  async stream(
    req: ChatRequest,
    onEvent: (ev: ProviderEvent) => void,
  ): Promise<StreamEnd> {
    const url = `${this.baseUrl.replace(/\/+$/, '')}/v1/messages`;
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens,
      stream: true,
      system: req.system,
      messages: toAnthropicMessages(req.messages),
    };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.schema,
      }));
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Anthropic API error ${res.status}: ${detail.slice(0, 2000)}`);
    }

    let stopReason: string | null = null;
    let usage: StreamEnd['usage'] = { input_tokens: 0, output_tokens: 0 };
    const blockIds = new Map<number, string>();
    const inputBuf = new Map<number, string>();

    for await (const sse of parseSse(res.body)) {
      let evt: Record<string, unknown>;
      try {
        evt = JSON.parse(sse.data) as Record<string, unknown>;
      } catch {
        continue;
      }
      const type = evt.type as string;

      if (type === 'message_start') {
        const u = (evt.message as { usage?: { input_tokens?: number } })?.usage;
        if (u?.input_tokens) usage = { ...usage, input_tokens: u.input_tokens };
      } else if (type === 'content_block_start') {
        const block = evt.content_block as AnthropicBlock;
        const index = evt.index as number;
        if (block.type === 'tool_use' && block.id && block.name) {
          onEvent({ kind: 'tool_use_start', id: block.id, name: block.name });
          blockIds.set(index, block.id);
          inputBuf.set(
            index,
            block.input && Object.keys(block.input as object).length > 0
              ? JSON.stringify(block.input)
              : '',
          );
        }
      } else if (type === 'content_block_delta') {
        const delta = evt.delta as AnthropicBlock & { partial_json?: string };
        const index = evt.index as number;
        if (delta.type === 'text_delta' && delta.text) {
          onEvent({ kind: 'text', text: delta.text });
        } else if (delta.type === 'thinking_delta' && delta.thinking) {
          onEvent({ kind: 'thinking', text: delta.thinking });
        } else if (delta.type === 'input_json_delta') {
          const partial = delta.partial_json ?? delta.text ?? '';
          inputBuf.set(index, (inputBuf.get(index) ?? '') + partial);
        }
      } else if (type === 'content_block_stop') {
        const index = evt.index as number;
        const json = inputBuf.get(index);
        const id = blockIds.get(index);
        if (json !== undefined && id !== undefined) {
          onEvent({ kind: 'tool_input_delta', id, partialJson: json });
          inputBuf.delete(index);
          blockIds.delete(index);
        }
      } else if (type === 'message_delta') {
        const d = evt.delta as { stop_reason?: string } | undefined;
        if (d?.stop_reason) stopReason = d.stop_reason;
        const u = evt.usage as { output_tokens?: number } | undefined;
        if (u?.output_tokens)
          usage = { ...usage, output_tokens: u.output_tokens };
      }
    }
    return { stopReason, usage };
  }
}
