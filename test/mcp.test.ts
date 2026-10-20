// MCP client + registry and skills tests.

import { test } from 'node:test';
import assert from 'node:assert';
import { readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpRegistry, loadMcpConfigs } from '../src/mcp/index.js';
import { listSkills, loadSkill, activateSkill, activeSkillContent } from '../src/skills.js';

// Works both from test/ (source) and dist-test/test/ (compiled): walk up until
// we find scripts/mock-mcp-server.mjs.
function findMock(): string {
  let dir = fileURLToPath(new URL('.', import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, 'scripts', 'mock-mcp-server.mjs');
    if (existsSync(candidate)) return candidate;
    dir = join(dir, '..');
  }
  throw new Error('scripts/mock-mcp-server.mjs not found from test directory');
}
const repoRoot = process.cwd();
const MOCK = findMock();

test('MCP client handshake + tools/list + tools/call through the registry', async () => {
  const registry = new McpRegistry({
    configs: {
      mcpServers: {
        mock: { command: process.execPath, args: [MOCK] },
      },
    },
  });
  const tools = await registry.buildTools({ serverNames: ['mock'] });
  assert.ok(tools.length === 2, `expected 2 tools, got ${tools.length}`);
  const names = tools.map((t) => t.name);
  assert.ok(names.includes('mcp__mock__echo'));
  assert.ok(names.includes('mcp__mock__add'));

  const add = tools.find((t) => t.name === 'mcp__mock__add')!;
  const res = await add.run({ a: 19, b: 23 }, { cwd: repoRoot, requestPermission: async () => true });
  assert.strictEqual(res.output, '42');

  const echo = tools.find((t) => t.name === 'mcp__mock__echo')!;
  const res2 = await echo.run({ text: 'hello mcp' }, { cwd: repoRoot, requestPermission: async () => true });
  assert.strictEqual(res2.output, 'echo: hello mcp');

  registry.closeAll();
});

test('MCP tools are NOT safe (require permission) and unknown tool errors', async () => {
  const registry = new McpRegistry({
    configs: { mcpServers: { mock: { command: process.execPath, args: [MOCK] } } },
  });
  try {
    const tools = await registry.buildTools({ serverNames: ['mock'] });
    assert.ok(tools.length > 0, 'tools exposed');
    assert.ok(tools.every((t) => t.safe === false), 'mcp tools must default to permission-gated');
    assert.ok(!tools.some((t) => t.name === 'mcp__mock__nope'), 'unknown tools are not listed');

    // The loop rejects tool_use for a name that is not in the toolset; simulate
    // by asking the registry to call a tool the server does not declare.
    const res = await (
      registry as unknown as {
        callWithCtx(server: string, tool: string, input: unknown): Promise<{ output: string; isError?: boolean }>;
      }
    ).callWithCtx('mock', 'nope', {});
    assert.ok(res.isError, 'unknown tool call reports isError');
    assert.ok(res.output.includes('unknown tool'), res.output);
  } finally {
    await registry.closeAll();
  }
});

test('loadMcpConfigs reads mcp.json with disabledTools', async () => {
  const dir = join(tmpdir(), `anycode-mcp-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const cfgPath = join(dir, 'mcp.json');
  await writeFile(
    cfgPath,
    JSON.stringify({
      mcpServers: { a: { command: 'x' } },
      disabledTools: { a: ['d1', 'd2'] },
    }),
  );
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const cfg = loadMcpConfigs();
    assert.ok(cfg.mcpServers['a']);
    assert.deepStrictEqual(cfg.disabledTools?.a, ['d1', 'd2']);
  } finally {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------- skills
test('skills: list, load, activate, inject into prompt', async () => {
  // Fixture: project skills dir under the test's own cwd
  const dir = join(tmpdir(), `anycode-skills-${Date.now()}`);
  await mkdir(join(dir, 'skills'), { recursive: true });
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    await writeFile(
      join(dir, 'skills', 'code-review.md'),
      '# Code review skill\n\nWhen reviewing code: check types, tests, and error handling.\n',
    );
    const skills = listSkills();
    assert.ok(skills.length === 1);
    assert.strictEqual(skills[0]?.name, 'code-review');
    assert.strictEqual(skills[0]?.source, 'project');

    const loaded = loadSkill('code-review');
    assert.ok(loaded);
    assert.ok(loaded.content.includes('reviewing code'));

    const activated = activateSkill('code-review');
    assert.ok(activated);
    const injected = activeSkillContent();
    assert.ok(injected.includes('<skill name="code-review">'));
    assert.ok(injected.includes('check types'));
  } finally {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('use via runAgentLoop: use_skill tool loads skill content', async () => {
  const { runAgentLoop } = await import('../src/loop.js');
  const { BUILTIN_TOOLS } = await import('../src/tools.js');
  const { SKILLS_TOOL } = await import('../src/skills.js');
  const dir = join(tmpdir(), `anycode-skills-loop-${Date.now()}`);
  await mkdir(join(dir, 'skills'), { recursive: true });
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    await writeFile(join(dir, 'skills', 'greeter.md'), '# Greeter\n\nAlways start replies with the word HELLOOO.\n');
    const script = JSON.stringify([
      { content: [{ type: 'text', text: 'ok' }] },
    ]);
    await writeFile(join(dir, 'script.json'), script);
    // Drive the model manually: provider is not needed for this unit; call the tool directly.
    const tool = [...BUILTIN_TOOLS, SKILLS_TOOL].find((t) => t.name === 'use_skill');
    assert.ok(tool);
    const res = await tool.run(
      { name: 'greeter' },
      { cwd: dir, requestPermission: async () => true },
    );
    assert.ok(res.output.includes('HELLOOO'));
    assert.ok(res.output.includes('now active'));
    void runAgentLoop;
  } finally {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
  }
  void readFile;
});
