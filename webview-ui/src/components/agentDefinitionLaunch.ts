/**
 * Agent definition helpers shared by the launch surfaces and the create-agent
 * modal (kept out of the component files so fast refresh keeps working).
 */

import type { AgentDefinition } from '../../../core/src/messages.js';

/** Built-in tools offered as toggles. None ticked means the CLI's default set. */
export const AGENT_TOOL_CHOICES = [
  'Read',
  'Edit',
  'Write',
  'Bash',
  'Grep',
  'Glob',
  'WebFetch',
  'WebSearch',
] as const;

/** Model aliases offered in the picker; '' is the CLI's default. */
export const AGENT_MODEL_CHOICES = ['', 'haiku', 'sonnet', 'opus'] as const;

/** The drawer's Agent definition section, passed through each launch surface. */
export interface AgentDefinitionLaunch {
  definitions: AgentDefinition[];
  /** Launch with this definition (into its first Directory, or the host's). */
  onSelect: (definition: AgentDefinition) => void;
  /** Open the create-agent modal empty (the pinned `+ New agent` row). */
  onAdd: () => void;
  /** Open the create-agent modal pre-filled. */
  onEdit: (definition: AgentDefinition) => void;
}

/** Wrap each callback so the surface closes its drawer first, as it does for
 *  the Directory rows. */
export function closingAgentDefinitionLaunch(
  launch: AgentDefinitionLaunch | undefined,
  close: () => void,
): AgentDefinitionLaunch | undefined {
  if (!launch) return undefined;
  return {
    definitions: launch.definitions,
    onSelect: (definition) => {
      close();
      launch.onSelect(definition);
    },
    onAdd: () => {
      close();
      launch.onAdd();
    },
    onEdit: (definition) => {
      close();
      launch.onEdit(definition);
    },
  };
}
