/**
 * Local skills an Agent definition can attach: every folder holding a SKILL.md
 * under the user's `~/.claude/skills` and under each Directory's
 * `.claude/skills`.
 *
 * Names are the folder names, unique across sources: a user skill wins over a
 * Directory skill of the same name, and between Directories the first listed
 * wins. That is the name an Agent definition stores.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse } from 'yaml';

import type { LocalSkill } from '../../../core/src/messages.js';

export interface SkillDirectory {
  name: string;
  path: string;
}

export function userSkillsDir(): string {
  return path.join(os.homedir(), '.claude', 'skills');
}

/** The `description:` from a SKILL.md's frontmatter, if it has one. */
export function readSkillDescription(skillMdPath: string): string | undefined {
  let text: string;
  try {
    text = fs.readFileSync(skillMdPath, 'utf-8');
  } catch {
    return undefined;
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return undefined;
  try {
    const front = parse(match[1]) as Record<string, unknown> | null;
    const description = front?.description;
    return typeof description === 'string' && description.trim() ? description.trim() : undefined;
  } catch {
    return undefined;
  }
}

function scanSkillsRoot(
  root: string,
  source: LocalSkill['source'],
  directoryName?: string,
): LocalSkill[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(root).sort();
  } catch {
    return [];
  }
  const out: LocalSkill[] = [];
  for (const entry of entries) {
    const skillPath = path.join(root, entry);
    const skillMd = path.join(skillPath, 'SKILL.md');
    if (!fs.existsSync(skillMd)) continue;
    const skill: LocalSkill = { name: entry, path: skillPath, source };
    const description = readSkillDescription(skillMd);
    if (description) skill.description = description;
    if (directoryName) skill.directoryName = directoryName;
    out.push(skill);
  }
  return out;
}

export function listLocalSkills(directories: SkillDirectory[]): LocalSkill[] {
  const byName = new Map<string, LocalSkill>();
  const add = (skills: LocalSkill[]) => {
    for (const skill of skills) if (!byName.has(skill.name)) byName.set(skill.name, skill);
  };
  add(scanSkillsRoot(userSkillsDir(), 'user'));
  for (const dir of directories) {
    add(scanSkillsRoot(path.join(dir.path, '.claude', 'skills'), 'directory', dir.name));
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
