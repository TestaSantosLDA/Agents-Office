/**
 * The Agent definition client messages, and the definition half of a launch.
 * Shaped like directories.ts's handler: success rebroadcasts the list to every
 * office, an ack or a refusal answers only the client that asked.
 */

import type { LaunchProfile } from '../../../core/src/provider.js';
import {
  findAgentDefinition,
  listAgentDefinitions,
  removeAgentDefinition,
  saveAgentDefinition,
} from './agentDefinitions.js';
import { concurrencyRefusal, planAgentLaunch, resolveLaunchDirectory } from './agentLaunch.js';
import { listLocalSkills, type SkillDirectory } from './localSkills.js';

export interface AgentDefinitionMessageDeps {
  broadcast: (message: Record<string, unknown>) => void;
  reply: (message: Record<string, unknown>) => void;
  /** Directories whose `.claude/skills` count as local skills. */
  skillDirectories: () => SkillDirectory[];
}

export function agentDefinitionsLoadedMessage(): Record<string, unknown> {
  return { type: 'agentDefinitionsLoaded', definitions: listAgentDefinitions() };
}

/** Returns false for any other message, so the host's switch stays intact. */
export function handleAgentDefinitionClientMessage(
  msg: Record<string, unknown>,
  deps: AgentDefinitionMessageDeps,
): boolean {
  switch (msg.type) {
    case 'saveAgentDefinition': {
      const raw = (msg.definition ?? {}) as Record<string, unknown>;
      const previousName = typeof msg.previousName === 'string' ? msg.previousName : undefined;
      const result = saveAgentDefinition(raw, previousName);
      if (!result.ok) {
        deps.reply({
          type: 'agentDefinitionRejected',
          name: typeof raw.name === 'string' ? raw.name : '',
          reason: result.reason,
        });
        return true;
      }
      deps.broadcast(agentDefinitionsLoadedMessage());
      deps.reply({ type: 'agentDefinitionSaved', definition: result.definition });
      return true;
    }

    case 'removeAgentDefinition': {
      if (typeof msg.name !== 'string') return true;
      const result = removeAgentDefinition(msg.name);
      if (!result.ok) {
        deps.reply({ type: 'agentDefinitionRejected', name: msg.name, reason: result.reason });
        return true;
      }
      deps.broadcast(agentDefinitionsLoadedMessage());
      return true;
    }

    case 'requestLocalSkills':
      deps.reply({ type: 'localSkillsLoaded', skills: listLocalSkills(deps.skillDirectories()) });
      return true;

    default:
      return false;
  }
}

export type DefinitionLaunch =
  | { ok: true; directoryPath: string; profile: LaunchProfile; definitionName: string }
  | { ok: false; reason: string };

/**
 * Everything a launch with a definition needs decided before a PTY spawns:
 * the definition exists, the Directory is allowed, there is room under
 * maxConcurrent, and the profile (with its plugin dir) is built.
 */
export function prepareDefinitionLaunch(input: {
  definitionName: string;
  requestedPath: string | undefined;
  fallbackPath: string;
  /** How many live agents already wear this definition's name. */
  running: (definitionName: string) => number;
  skillDirectories: SkillDirectory[];
}): DefinitionLaunch {
  const definition = findAgentDefinition(input.definitionName);
  if (!definition) return { ok: false, reason: `No agent called ${input.definitionName}.` };

  const where = resolveLaunchDirectory(definition, input.requestedPath, input.fallbackPath);
  if (!where.ok) return where;

  const refusal = concurrencyRefusal(definition, input.running(definition.name));
  if (refusal) return { ok: false, reason: refusal };

  let plan;
  try {
    plan = planAgentLaunch(definition, where.path, listLocalSkills(input.skillDirectories));
  } catch (err) {
    return { ok: false, reason: `Could not prepare ${definition.name}'s skills: ${String(err)}` };
  }
  if (plan.missingSkills.length > 0) {
    console.warn(
      `[Pixel Agents] ${definition.name}: skills not found locally, skipped: ${plan.missingSkills.join(', ')}`,
    );
  }
  return {
    ok: true,
    directoryPath: where.path,
    profile: plan.profile,
    definitionName: definition.name,
  };
}
