// Mock MCP model server scripting an MCP tool call for CLI end-to-end verification.
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 8871);

createServer((req, res) => {
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => {
    const body = JSON.parse(data || '{}');
    const msgs = JSON.stringify(body.messages ?? []);
    const events = msgs.includes('echo: hi from mcp')
      ? [
          { choices: [{ delta: { content: 'MCP tool said: ' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]
      : [
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call1', type: 'function', function: { name: 'mcp__mock__echo', arguments: '' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"text": "hi from mcp"}' } }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const ev of events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
}).listen(port, '0.0.0.0', () => console.log(`mock model on :${port}`));
