// Mock MCP server over stdio (JSON-RPC 2.0), for testing anycode's MCP client.
// Tools: echo(text) -> echoes; add(a,b) -> sum. Answers tools/list and tools/call.
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });
let nextId = 1; // notifications/responses only; requests unused
void nextId;

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

rl.on('line', (line) => {
  const raw = line.trim();
  if (!raw) return;
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (msg.method === 'initialize') {
    respond(msg.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'mock-mcp', version: '1.0.0' },
    });
  } else if (msg.method === 'notifications/initialized') {
    // no response needed
  } else if (msg.method === 'tools/list') {
    respond(msg.id, {
      tools: [
        { name: 'echo', description: 'Echoes back the input text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
        { name: 'add', description: 'Sums two numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
      ],
    });
  } else if (msg.method === 'tools/call') {
    const { name, arguments: args } = msg.params ?? {};
    if (name === 'echo') {
      respond(msg.id, { content: [{ type: 'text', text: `echo: ${args?.text ?? ''}` }] });
    } else if (name === 'add') {
      respond(msg.id, { content: [{ type: 'text', text: String(Number(args?.a) + Number(args?.b)) }] });
    } else {
      respond(msg.id, { content: [{ type: 'text', text: `unknown tool ${name}` }], isError: true });
    }
  } else if (msg.id !== undefined) {
    respond(msg.id, {});
  }
});
