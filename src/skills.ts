// Skills: small markdown instruction packages the agent can load on demand.
// Lookup order: ./skills/, ~/.anycode/skills/. Each skill = <name>.md
// (or <name>/SKILL.md for richer packs). First heading line = display title.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Tool } from './tools.js';

export interface SkillMeta {
  name: string;
  title: string;
  source: string;
  lineCount: number;
}

export interface LoadedSkill extends SkillMeta {
  content: string;
}

function skillDirs(): string[] {
  const dirs = [
    join(process.cwd(), 'skills'),
    join(homedir(), '.anycode', 'skills'),
  ];
  return dirs.filter((d) => existsSync(d));
}

function skillCandidates(): Array<{ name: string; file: string }> {
  const files: Array<{ name: string; file: string }> = [];
  for (const dir of skillDirs()) {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && (e.name.endsWith('.md') || e.name.endsWith('.skill.md'))) {
        const name = e.name.replace(/\.skill\.md$/, '.md').replace(/\.md$/, '');
        files.push({ name, file: join(dir, e.name) });
      } else if (e.isDirectory()) {
        const skillFile = join(dir, e.name, 'SKILL.md');
        if (existsSync(skillFile)) files.push({ name: e.name, file: skillFile });
      }
    }
  }
  // dedupe by name, first defined wins (project dir shadows user dir)
  const seen = new Set<string>();
  return files.filter((f) => {
    if (seen.has(f.name)) return false;
    seen.add(f.name);
    return true;
  });
}

export function listSkills(): SkillMeta[] {
  const out: SkillMeta[] = [];
  for (const c of skillCandidates()) {
    try {
      const raw = readFileSync(c.file, 'utf8');
      const firstLine = raw.split('\n').find((l) => l.trim() !== '') ?? '';
      out.push({
        name: c.name,
        title: firstLine.replace(/^#+\s*/, '').slice(0, 80),
        source: c.file.startsWith(homedir()) ? 'user' : 'project',
        lineCount: raw.split('\n').length,
      });
    } catch {
      continue;
    }
  }
  return out;
}

export function loadSkill(name: string): LoadedSkill | null {
  const c = skillCandidates().find((x) => x.name === name);
  if (!c) return null;
  const content = readFileSync(c.file, 'utf8');
  const meta = listSkills().find((s) => s.name === name)!;
  return { ...meta, content };
}

/** Activated skill names this session; injected into the system prompt. */
const activeSkills: string[] = [];

export function activateSkill(name: string): LoadedSkill | null {
  if (!activeSkills.includes(name)) activeSkills.push(name);
  return loadSkill(name);
}

export function activeSkillContent(): string {
  const parts: string[] = [];
  for (const name of activeSkills) {
    const s = loadSkill(name);
    if (s) parts.push(`<skill name="${s.name}">\n${s.content.trim()}\n</skill>`);
  }
  return parts.join('\n\n');
}

export function activeSkillNames(): string[] {
  return [...activeSkills];
}

const useSkillTool: Tool = {
  name: 'use_skill',
  description:
    'Load a saved skill (reusable instruction set) by name. Call list via /skills or just try a plausible name; returns the full skill content as instructions for the current task.',
  schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Skill name (file under skills/ without .md)' },
    },
    required: ['name'],
  },
  safe: true,
  async run(input) {
    const name = String(input['name'] ?? '');
    const skill = activateSkill(name);
    if (!skill) {
      const available = listSkills().map((s) => s.name).join(', ');
      return {
        output: `Skill "${name}" not found. Available: ${available || '(none - create skills/<name>.md)'}`,
        isError: true,
      };
    }
    return {
      output: `Skill "${skill.name}" is now active for this session.\n\n${skill.content}`,
    };
  },
};

export const SKILLS_TOOL: Tool = useSkillTool;
