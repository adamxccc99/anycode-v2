// Mock OpenAI-compatible /chat/completions server for local testing.
// Serves a scripted 2-turn task: ask for a `write` tool call, then finish.
// Usage: node mock-server.mjs [port]
import { createServer } from 'node:http';
import { join } from 'node:path';

const port = Number(process.argv[2] ?? 8787);
const dir = process.env.MOCK_TARGET_DIR ?? process.cwd();

createServer((req, res) => {
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => {
    const body = JSON.parse(data || '{}');
    const hasToolResult = JSON.stringify(body.messages ?? []).includes('Wrote ');
    const events = hasToolResult
      ? [
          { choices: [{ delta: { content: 'Done: file written. Task complete.' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]
      : [
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'write', arguments: '' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"file_path": ' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(join(dir, 'mockdemo.txt')) } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ', "content": "created by anycode over a mock model"}' } }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const ev of events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
}).listen(port, '0.0.0.0', () => console.log(`mock model on :${port}`));
