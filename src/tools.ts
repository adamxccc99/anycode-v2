// Built-in tools with original implementations.
// Input field names echo the published public tool contract for familiarity.

import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, join } from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export interface ToolContext {
  /** Working directory tools resolve relative paths against. */
  cwd: string;
  /** Ask the user (or auto-allow) for permission to run a tool. */
  requestPermission: (tool: string, summary: string) => Promise<boolean>;
  /** Live stdout/stderr callback for the Bash tool. */
  onBashOutput?: (line: string) => void;
}

export interface ToolResult {
  output: string;
  isError?: boolean;
}

export interface Tool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  /** Can run without asking (read-only tools). */
  safe: boolean;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

const MAX_OUTPUT = 30_000;

function str(i: Record<string, unknown>, k: string): string {
  const v = i[k];
  if (typeof v !== 'string') throw new Error(`tool input "${k}" must be a string`);
  return v;
}
function optNum(i: Record<string, unknown>, k: string): number | undefined {
  const v = i[k];
  return typeof v === 'number' ? v : undefined;
}
function optBool(i: Record<string, unknown>, k: string): boolean {
  return i[k] === true;
}
function absPath(p: string, cwd: string): string {
  return isAbsolute(p) ? p : resolve(cwd, p);
}
function clip(s: string, max = MAX_OUTPUT): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n… [truncated ${s.length - max} chars]`;
}
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------- list_files
async function walkFiles(dir: string, depth: number, out: string[]): Promise<void> {
  if (depth === 0 || out.length > 500) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (out.length > 500) return;
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(`${p}/`);
      await walkFiles(p, depth - 1, out);
    } else {
      out.push(p);
    }
  }
}

const listFiles: Tool = {
  name: 'list_files',
  description:
    'List files and directories under a path so you can explore project structure. Read-only.',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory to list; "." for cwd' },
    },
    required: ['path'],
  },
  safe: true,
  async run(input, ctx) {
    const dir = absPath(str(input, 'path'), ctx.cwd);
    const out: string[] = [];
    await walkFiles(dir, 3, out);
    return { output: clip(out.join('\n') || '(empty)') };
  },
};

// ---------------------------------------------------------------------- read
const read: Tool = {
  name: 'read',
  description:
    'Read a file from the local filesystem. Lines are numbered. Use offset to page through long files.',
  schema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute or cwd-relative path' },
      offset: { type: 'number', description: '1-based line to start from' },
      limit: { type: 'number', description: 'Max lines (default 2000)' },
    },
    required: ['file_path'],
  },
  safe: true,
  async run(input, ctx) {
    const p = absPath(str(input, 'file_path'), ctx.cwd);
    const raw = await readFile(p, 'utf8');
    const lines = raw.split('\n');
    const offset = optNum(input, 'offset') ?? 1;
    const limit = optNum(input, 'limit') ?? 2000;
    const start = Math.max(1, offset);
    const slice = lines.slice(start - 1, start - 1 + limit);
    const body = slice
      .map((l, i) => `${String(start + i).padStart(6)}\t${l}`)
      .join('\n');
    const more =
      start - 1 + limit < lines.length
        ? `\n… (${lines.length - (start - 1 + limit)} more lines; read with offset=${start + limit})`
        : '';
    return { output: clip(body + more) };
  },
};

// --------------------------------------------------------------------- write
const write: Tool = {
  name: 'write',
  description:
    'Write a file to the local filesystem, creating parent directories. Overwrites existing content.',
  schema: {
    type: 'object',
    properties: {
      file_path: { type: 'string' },
      content: { type: 'string', description: 'Full file content' },
    },
    required: ['file_path', 'content'],
  },
  safe: false,
  async run(input, ctx) {
    const p = absPath(str(input, 'file_path'), ctx.cwd);
    const content = str(input, 'content');
    const ok = await ctx.requestPermission(
      'write',
      `write ${p} (${content.length} bytes)`,
    );
    if (!ok) return { output: 'User declined this write.', isError: true };
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, content, 'utf8');
    return { output: `Wrote ${p} (${content.length} bytes)` };
  },
};

// ---------------------------------------------------------------------- edit
const edit: Tool = {
  name: 'edit',
  description:
    'Exact string replacement in an existing file. old_string must appear exactly once unless replace_all is true.',
  schema: {
    type: 'object',
    properties: {
      file_path: { type: 'string' },
      old_string: { type: 'string' },
      new_string: { type: 'string' },
      replace_all: { type: 'boolean' },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
  safe: false,
  async run(input, ctx) {
    const p = absPath(str(input, 'file_path'), ctx.cwd);
    const oldS = str(input, 'old_string');
    const newS = str(input, 'new_string');
    const replaceAll = optBool(input, 'replace_all');
    if (oldS === newS)
      return { output: 'old_string equals new_string; nothing to do', isError: true };
    const ok = await ctx.requestPermission('edit', `edit ${p}`);
    if (!ok) return { output: 'User declined this edit.', isError: true };

    const raw = await readFile(p, 'utf8');
    const count = raw.split(oldS).length - 1;
    if (count === 0) {
      const hint = nearMissHint(raw, oldS);
      return { output: `old_string not found in ${p}.${hint}`, isError: true };
    }
    if (count > 1 && !replaceAll) {
      return {
        output: `old_string matches ${count} times; include surrounding lines to make it unique, or set replace_all.`,
        isError: true,
      };
    }
    const updated = replaceAll
      ? raw.split(oldS).join(newS)
      : raw.replace(oldS, newS);
    await writeFile(p, updated, 'utf8');
    return {
      output: `Edited ${p} (${replaceAll ? `all ${count}` : '1'} match)`,
    };
  },
};

async function nearMissHint(raw: string, oldS: string): Promise<string> {
  const firstLine = (oldS.split('\n')[0] ?? '').trim();
  if (firstLine.length > 8) {
    const idx = raw.indexOf(firstLine);
    if (idx !== -1) {
      const lineNo = raw.slice(0, idx).split('\n').length;
      return ` First line matches near line ${lineNo} — copy lines exactly as they appear in the file.`;
    }
  }
  return '';
}

// ---------------------------------------------------------------------- bash
const bash: Tool = {
  name: 'bash',
  description:
    'Run a shell command (/bin/bash -c). Returns stdout, stderr and exit code. Use for builds, tests, git, package installs.',
  schema: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      timeout_seconds: { type: 'number', description: 'Default 90' },
      summary: { type: 'string', description: 'Short label shown to the user' },
    },
    required: ['command'],
  },
  safe: false,
  async run(input, ctx) {
    const command = str(input, 'command');
    const timeoutS = optNum(input, 'timeout_seconds') ?? 90;
    const ok = await ctx.requestPermission('bash', command.slice(0, 160));
    if (!ok) return { output: 'User declined this command.', isError: true };

    return await new Promise<ToolResult>((res) => {
      let settled = false;
      const child = spawn('/bin/bash', ['-c', command], {
        cwd: ctx.cwd,
        timeout: timeoutS * 1000,
        env: { ...process.env, TERM: 'dumb' },
      });
      let out = '';
      let errOut = '';
      child.stdout.on('data', (d: Buffer) => {
        out += d.toString();
        ctx.onBashOutput?.(d.toString());
      });
      child.stderr.on('data', (d: Buffer) => {
        errOut += d.toString();
        ctx.onBashOutput?.(d.toString());
      });
      child.on('error', (e) => {
        if (!settled) {
          settled = true;
          res({ output: `spawn failed: ${String(e)}`, isError: true });
        }
      });
      child.on('close', (code, signal) => {
        if (settled) return;
        settled = true;
        const parts: string[] = [];
        if (out.trim()) parts.push(clip(out));
        if (errOut.trim()) parts.push(`[stderr]\n${clip(errOut)}`);
        parts.push(`exit ${code ?? 'none'}${signal ? ` (${signal})` : ''}`);
        res({
          output: clip(parts.join('\n')),
          isError: code !== 0 && code !== null,
        });
      });
    });
  },
};

// ---------------------------------------------------------------------- glob
const glob: Tool = {
  name: 'glob',
  description: 'Find files matching a glob pattern like "src/**/*.ts". Read-only.',
  schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      path: { type: 'string', description: 'Base directory (default cwd)' },
    },
    required: ['pattern'],
  },
  safe: true,
  async run(input, ctx) {
    const pattern = str(input, 'pattern');
    const base = absPath(
      typeof input['path'] === 'string' ? input['path'] : '.',
      ctx.cwd,
    );
    // Dependency-free glob via bash compgen (brace/star/** expansions).
    const out = await execFileP(
      '/bin/bash',
      ['-c', `compgen -G ${shq(pattern)} | head -200`],
      { cwd: base, timeout: 15_000 },
    ).catch(() => ({ stdout: '' }));
    const lines = out.stdout.split('\n').filter(Boolean);
    if (lines.length === 0) return { output: 'No matches' };
    return { output: clip(lines.join('\n')) };
  },
};

// ---------------------------------------------------------------------- grep
const grep: Tool = {
  name: 'grep',
  description:
    'Search file contents with a POSIX extended regex. Output is file:line: text. Read-only.',
  schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'POSIX ERE regex' },
      path: { type: 'string', description: 'File or directory (default cwd)' },
      glob_include: { type: 'string', description: 'e.g. "*.ts"' },
      case_insensitive: { type: 'boolean' },
      context: { type: 'number', description: 'Context lines, default 0' },
    },
    required: ['pattern'],
  },
  safe: true,
  async run(input, ctx) {
    const pattern = str(input, 'pattern');
    const base = absPath(
      typeof input['path'] === 'string' ? input['path'] : '.',
      ctx.cwd,
    );
    const cmd =
      `cd ${shq(base)} && grep -rInE ` +
      (optBool(input, 'case_insensitive') ? '-i ' : '') +
      `--context=${optNum(input, 'context') ?? 0} ` +
      (typeof input['glob_include'] === 'string'
        ? `--include=${shq(String(input['glob_include']))} `
        : '') +
      `${shq(pattern)} . 2>/dev/null | head -400; true`;
    const out = await execFileP('/bin/bash', ['-c', cmd], {
      timeout: 20_000,
    }).catch((e: { stdout?: string }) => ({ stdout: e.stdout ?? '' }));
    if (!out.stdout.trim()) return { output: 'No matches' };
    return { output: clip(out.stdout) };
  },
};

// ----------------------------------------------------------------- todo_list
export type Todo = { content: string; status: 'pending' | 'in_progress' | 'completed' };

const todoStore: { todos: Todo[] } = { todos: [] };

const todoWrite: Tool = {
  name: 'todo_write',
  description:
    'Maintain a visible task list for the current job. Rewrite the full list with every call and mark progress.',
  schema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string' },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed'],
            },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  safe: true,
  async run(input) {
    const todos = input['todos'] as Array<{
      content: string;
      status: Todo['status'];
    }>;
    todoStore.todos = todos.map((t) => ({
      content: String(t.content),
      status: t.status,
    }));
    const line = (t: Todo, i: number) => `${i + 1}. [${t.status}] ${t.content}`;
    return { output: todoStore.todos.map(line).join('\n') };
  },
};

export function currentTodos(): Todo[] {
  return todoStore.todos;
}

export const BUILTIN_TOOLS: Tool[] = [
  read,
  write,
  edit,
  bash,
  glob,
  grep,
  listFiles,
  todoWrite,
];
