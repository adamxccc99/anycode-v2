// Model-neutral types shared by providers, the agent loop, and tools.

export type Role = 'user' | 'assistant';

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string; signature?: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export interface ChatMessage {
  role: Role;
  content: string | ContentBlock[];
}

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the input object. */
  schema: Record<string, unknown>;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

export interface StreamEnd {
  stopReason: string | null;
  usage: Usage;
}

export type ProviderEvent =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_use_start'; id: string; name: string }
  | { kind: 'tool_input_delta'; id: string; partialJson: string }
  | { kind: 'end'; stopReason: string | null; usage: Usage };

export interface ChatRequest {
  model: string;
  system: string;
  messages: ChatMessage[];
  tools: ToolDef[];
  maxTokens: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface ChatProvider {
  readonly name: string;
  stream(
    req: ChatRequest,
    onEvent: (ev: ProviderEvent) => void,
  ): Promise<StreamEnd>;
}
