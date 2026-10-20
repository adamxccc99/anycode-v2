// End-to-end tests: scripted mock model servers (OpenAI + Anthropic SSE),
// driving the full agent loop and tool execution.

import { test } from 'node:test';
import assert from 'node:assert';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { OpenAiProvider } from '../src/providers/openai.js';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { runAgentLoop } from '../src/loop.js';
import { BUILTIN_TOOLS } from '../src/tools.js';
import type { ChatMessage } from '../src/types.js';

function sseRes(res: import('node:http').ServerResponse, events: unknown[]) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
  });
  res.write(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''));
  res.end();
}

function startServer(
  handler: (body: unknown, res: import('node:http').ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void>; lastBody: { v: unknown } }> {
  const lastBody = { v: undefined as unknown };
  const server: Server = createServer((req, res) => {
    let data = '';
    req.on('data', (c: Buffer) => (data += c));
    req.on('end', () => {
      lastBody.v = JSON.parse(data || '{}');
      handler(lastBody.v, res);
    });
  });
  return new Promise<{ url: string; close: () => Promise<void>; lastBody: { v: unknown } }>((resolve) => {
    server.listen(0, '127.0.0.1', async () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r, _e) => server.close(() => r())),
        lastBody,
      });
    });
  });
}

const anyYes = async () => true;

// ------------------------------------------------------------------ OpenAI
test('openai provider streams text', async () => {
  const s = await startServer((_body, res) =>
    sseRes(res, [
      { choices: [{ delta: { content: 'Hello' } }] },
      { choices: [{ delta: { content: ', local model.' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ]),
  );
  const out: string[] = [];
  const prov = new OpenAiProvider('test-key', s.url);
  const end = await prov.stream(
    {
      model: 'm1', system: 'sys', messages: [{ role: 'user', content: 'hi' }],
      tools: [], maxTokens: 100,
    },
    (ev) => {
      if (ev.kind === 'text') out.push(ev.text);
    },
  );
  assert.strictEqual(out.join(''), 'Hello, local model.');
  assert.deepStrictEqual(end.usage, { input_tokens: 10, output_tokens: 5 });
  await s.close();
});

// ------------------------------------------------------------ e2e: OpenAI
test('agent loop completes a task using the write tool (openai-compatible)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anycode-'));
  let request = 0;
  const s = await startServer((_body, res) => {
    request++;
    if (request === 1) {
      sseRes(res, [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call1', type: 'function', function: { name: 'write', arguments: '{"file_path":' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: `"${join(dir, 'hello.txt')}", "content": "hi from anycode"}` } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      ]);
    } else {
      sseRes(res, [
        { choices: [{ delta: { content: 'Wrote the file. Task complete.' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]);
    }
  });

  const history: ChatMessage[] = [];
  const result = await runAgentLoop(history, 'create hello.txt', {
    provider: new OpenAiProvider('k', s.url),
    model: 'mock-1',
    maxTokens: 2048,
    tools: BUILTIN_TOOLS,
    system: 'test',
    cwd: dir,
    requestPermission: anyYes,
  });

  assert.strictEqual(result.finalText, 'Wrote the file. Task complete.');
  const written = await readFile(join(dir, 'hello.txt'), 'utf8');
  assert.strictEqual(written, 'hi from anycode');
  assert.ok(result.turns === 2, `expected 2 turns, got ${result.turns}`);
  // Second request must carry the tool result back
  const second = s.lastBody.v as { messages: Array<{ role: string; content?: string }> };
  const toolMsg = second.messages.find((m) => m.role === 'tool');
  assert.ok(toolMsg, 'tool result should be in second request');
  assert.ok(String(toolMsg?.content).includes('Wrote'), 'tool result mentions success');
  assert.ok(history.length === 4, `history: user, assistant(tool_use), user(results), assistant(final) — got ${history.length}`);
  await s.close();
});

// -------------------------------------------------------------- e2e: Anth
test('agent loop completes a task using the write tool (anthropic)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anycode-anth-'));
  let request = 0;
  const s = await startServer((_body, res) => {
    request++;
    if (request === 1) {
      sseRes(res, [
        { type: 'message_start', message: { usage: { input_tokens: 42 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'write', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: `${join(dir, 'x.txt')}", "content": "done-via-tool"}` } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 33 } },
      ]);
    } else {
      sseRes(res, [
        { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'File created.' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 40 } },
      ]);
    }
  });

  const result = await runAgentLoop([], 'make x.txt', {
    provider: new AnthropicProvider('test-key', s.url),
    model: 'claude-mock',
    maxTokens: 2048,
    tools: BUILTIN_TOOLS,
    system: 'test',
    cwd: dir,
    requestPermission: anyYes,
  });

  assert.strictEqual(result.finalText, 'File created.');
  assert.strictEqual(await readFile(join(dir, 'x.txt'), 'utf8'), 'done-via-tool');
  const first = (s.lastBody as { v: { tools?: unknown[] } }).v;
  assert.ok(Array.isArray(first?.tools) && first.tools.length === BUILTIN_TOOLS.length, 'tool defs sent to provider');
  await s.close();
});

// ------------------------------------------------------------ bash + grep
test('bash tool runs and grep/search roundtrip', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anycode-bash-'));
  const bashTool = BUILTIN_TOOLS.find((t) => t.name === 'bash');
  const grepTool = BUILTIN_TOOLS.find((t) => t.name === 'grep');
  assert.ok(bashTool && grepTool);
  const ctx = { cwd: dir, requestPermission: anyYes };
  const r1 = await bashTool.run({ command: 'echo retval; printf z > z.txt' }, ctx);
  assert.ok(r1.output.includes('retval'), r1.output);
  await readFile(join(dir, 'z.txt'), 'utf8');
  const r2 = await grepTool.run({ pattern: 'z' }, ctx);
  assert.ok(r2.output.includes('z.txt'), r2.output);
});
