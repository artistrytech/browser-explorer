import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AiAgent } from './aiStore.js';

/**
 * AI チャットの送信欄で選べるスキルの一覧。CLI と同じ場所の SKILL.md を探す。
 * - Claude: <フォルダ>/.claude/skills, ~/.claude/skills (CLAUDE_CONFIG_DIR) と、同じ場所の commands/*.md
 * - Codex: <フォルダ>/.agents/skills, <フォルダ>/.codex/skills, ~/.agents/skills, ~/.codex/skills (CODEX_HOME。.system を含む)
 * <フォルダ> はベースフォルダからリポジトリのルートまで (リポジトリ外はベースフォルダだけ)
 */

export interface AiSkill {
  name: string;
  description: string;
  source: 'project' | 'user' | 'system';
}

/** スキルのフォルダを探す深さ (Codex の skills/.system/<name> のような 1 段の入れ子まで) */
const MAX_DEPTH = 2;
const MAX_DESCRIPTION = 300;

/** SKILL.md の先頭の YAML (name / description 等の 1 行の値と、> | の複数行の値だけ読む) */
function frontmatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out: Record<string, string> = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let value = kv[2].trim();
    if (/^[>|][-+]?$/.test(value) || value === '') {
      const block: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) block.push(lines[++i].trim());
      value = block.join(' ');
    }
    out[kv[1]] = value.replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}

async function readSkill(file: string, fallbackName: string, source: AiSkill['source']): Promise<AiSkill | null> {
  const text = await fs.readFile(file, 'utf8').catch(() => null);
  if (text === null) return null;
  const fm = frontmatter(text);
  if (fm['user-invocable'] === 'false') return null;
  return { name: fm.name || fallbackName, description: (fm.description ?? '').slice(0, MAX_DESCRIPTION), source };
}

/** dir の下の <name>/SKILL.md を集める (SKILL.md の無いフォルダは MAX_DEPTH まで中を探す) */
async function scanSkills(dir: string, source: AiSkill['source'], depth = MAX_DEPTH): Promise<AiSkill[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const found = await Promise.all(
    entries
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map(async (e): Promise<AiSkill[]> => {
        const sub = path.join(dir, e.name);
        // Codex の同梱スキル (skills/.system) は system として扱う
        const src = e.name === '.system' ? 'system' : source;
        const skill = await readSkill(path.join(sub, 'SKILL.md'), e.name, src);
        if (skill) return [skill];
        return depth > 1 ? scanSkills(sub, src, depth - 1) : [];
      }),
  );
  return found.flat();
}

/** Claude のカスタムコマンド (commands/*.md。スキルと同じく /名前 で呼べる) */
async function scanCommands(dir: string, source: AiSkill['source']): Promise<AiSkill[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const found = await Promise.all(
    entries
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => readSkill(path.join(dir, e.name), e.name.slice(0, -3), source)),
  );
  return found.filter((s): s is AiSkill => s !== null);
}

/** cwd からリポジトリのルートまでのフォルダ (近い順。リポジトリ外は cwd だけ) */
function projectDirs(cwd: string): string[] {
  const dirs: string[] = [];
  let dir = path.resolve(cwd);
  for (;;) {
    dirs.push(dir);
    if (existsSync(path.join(dir, '.git'))) return dirs;
    const parent = path.dirname(dir);
    if (parent === dir) return [path.resolve(cwd)];
    dir = parent;
  }
}

/** cwd で agent が使えるスキル (同じ名前はプロジェクト → ユーザーの順で先のものを使う。名前順) */
export async function listSkills(agent: AiAgent, cwd: string): Promise<AiSkill[]> {
  const home = os.homedir();
  const groups: Promise<AiSkill[]>[] = [];
  if (agent === 'claude') {
    const userDir = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
    for (const d of projectDirs(cwd)) {
      groups.push(scanSkills(path.join(d, '.claude', 'skills'), 'project'));
      groups.push(scanCommands(path.join(d, '.claude', 'commands'), 'project'));
    }
    groups.push(scanSkills(path.join(userDir, 'skills'), 'user'));
    groups.push(scanCommands(path.join(userDir, 'commands'), 'user'));
  } else {
    const codexHome = process.env.CODEX_HOME || path.join(home, '.codex');
    for (const d of projectDirs(cwd)) {
      groups.push(scanSkills(path.join(d, '.agents', 'skills'), 'project'));
      groups.push(scanSkills(path.join(d, '.codex', 'skills'), 'project'));
    }
    groups.push(scanSkills(path.join(home, '.agents', 'skills'), 'user'));
    groups.push(scanSkills(path.join(codexHome, 'skills'), 'user'));
  }
  const seen = new Map<string, AiSkill>();
  for (const s of (await Promise.all(groups)).flat()) {
    if (!seen.has(s.name)) seen.set(s.name, s);
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}
