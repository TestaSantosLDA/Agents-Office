/**
 * Turning an Agent definition into a launch: which Directory, whether another
 * one may start, and the CLI-agnostic LaunchProfile the provider maps to flags.
 *
 * Skills: the agent runs on the user's own CLI login and config, so user skills
 * (`~/.claude/skills`) and the launch Directory's own `.claude/skills` are
 * already loaded. Attaching one names it in the system prompt. Skills that live
 * anywhere else (another Directory) are loaded for this agent only through a
 * generated plugin directory whose `skills/` symlinks to them.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { AgentDefinition, LocalSkill } from '../../../core/src/messages.js';
import type { LaunchProfile } from '../../../core/src/provider.js';
import { normalizeDirectoryPath } from '../directories.js';
import { agentDefinitionsDir, slugifyAgentName } from './agentDefinitions.js';

export type LaunchDirectoryResult = { ok: true; path: string } | { ok: false; reason: string };

/**
 * Where a definition launches: the requested Directory if the definition allows
 * it, else its first Directory, else the fallback (the server's start dir).
 */
export function resolveLaunchDirectory(
  definition: AgentDefinition,
  requested: string | undefined,
  fallback: string,
): LaunchDirectoryResult {
  const allowed = definition.directories ?? [];
  if (requested === undefined) return { ok: true, path: allowed[0] ?? fallback };
  if (allowed.length === 0) return { ok: true, path: requested };
  const key = normalizeDirectoryPath(requested);
  if (allowed.some((d) => normalizeDirectoryPath(d) === key)) return { ok: true, path: requested };
  return {
    ok: false,
    reason: `${definition.name} may only be launched into: ${allowed.join(', ')}`,
  };
}

/** Null when another agent may start, else why not. */
export function concurrencyRefusal(
  definition: AgentDefinition,
  runningWithDefinition: number,
): string | null {
  const max = definition.maxConcurrent ?? 0;
  if (max > 0 && runningWithDefinition >= max) {
    return `${definition.name} is already running ${runningWithDefinition} of ${max} allowed.`;
  }
  return null;
}

/** The text appended to the CLI's system prompt. */
export function buildRolePrompt(definition: AgentDefinition, skillNames: string[]): string {
  const lines = [`You are ${definition.name}, an agent in Agent Office. Role: ${definition.role}.`];
  if (definition.bestAt) lines.push(`You are best at: ${definition.bestAt}.`);
  if (definition.tags?.length) lines.push(`Areas of focus: ${definition.tags.join(', ')}.`);
  if (skillNames.length > 0) {
    lines.push(`Use these skills when they apply: ${skillNames.join(', ')}.`);
  }
  if (definition.prompt) lines.push('', definition.prompt);
  return lines.join('\n');
}

/** `~/.pixel-agents/agents/.plugins/<slug>`: regenerated on every launch. */
export function agentPluginDir(definition: AgentDefinition): string {
  return path.join(agentDefinitionsDir(), '.plugins', slugifyAgentName(definition.name));
}

/**
 * Write the agent's plugin: a manifest plus `skills/<name>` symlinks. Rebuilt
 * from scratch so a skill detached since the last launch is gone.
 */
export function writeAgentPlugin(definition: AgentDefinition, skills: LocalSkill[]): string {
  const dir = agentPluginDir(definition);
  const slug = slugifyAgentName(definition.name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'skills'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify(
      {
        name: `agent-${slug}`,
        version: '0.0.0',
        description: `Skills attached to ${definition.name} by Agent Office.`,
      },
      null,
      2,
    ),
  );
  for (const skill of skills) {
    // A junction needs no admin rights on Windows; elsewhere the type is ignored.
    fs.symlinkSync(skill.path, path.join(dir, 'skills', skill.name), 'junction');
  }
  return dir;
}

export interface AgentLaunchPlan {
  profile: LaunchProfile;
  /** Attached skill names that no longer exist locally. Logged, not fatal. */
  missingSkills: string[];
}

/**
 * The LaunchProfile for one launch into `cwd`. Writes the plugin directory as a
 * side effect, only when there are skills it has to carry.
 */
export function planAgentLaunch(
  definition: AgentDefinition,
  cwd: string,
  localSkills: LocalSkill[],
): AgentLaunchPlan {
  const byName = new Map(localSkills.map((s) => [s.name, s]));
  const attached: LocalSkill[] = [];
  const missingSkills: string[] = [];
  for (const name of definition.skills ?? []) {
    const skill = byName.get(name);
    if (skill) attached.push(skill);
    else missingSkills.push(name);
  }

  // Already loaded by the CLI itself: user skills, and the launch Directory's own.
  const cwdSkillsRoot = normalizeDirectoryPath(path.join(cwd, '.claude', 'skills'));
  const needsPlugin = attached.filter(
    (s) => s.source !== 'user' && normalizeDirectoryPath(path.dirname(s.path)) !== cwdSkillsRoot,
  );

  const profile: LaunchProfile = {
    appendSystemPrompt: buildRolePrompt(
      definition,
      attached.map((s) => s.name),
    ),
  };
  if (definition.model) profile.model = definition.model;
  if (definition.tools?.length) profile.tools = definition.tools;
  if (needsPlugin.length > 0) profile.pluginDirs = [writeAgentPlugin(definition, needsPlugin)];
  return { profile, missingSkills };
}
