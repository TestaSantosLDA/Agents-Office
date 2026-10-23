/**
 * The words the pipeline sends: the triage command, the router's question and
 * how its answer is read, and the worker's first prompt. Pure, so every rule
 * about what an agent is told lives (and is tested) in one place.
 */

import type { AgentDefinition, Task } from '../../../core/src/messages.js';

/** Roles that run pipeline steps rather than tickets; never routed to. */
export const PIPELINE_ROLES = ['router', 'triage', 'reviewer'] as const;
export const ROUTER_ROLE = 'router';
export const TRIAGE_ROLE = 'triage';
export const GENERALIST_ROLE = 'generalist';

const hasRole = (d: AgentDefinition, role: string) => d.role.trim().toLowerCase() === role;

export function findDefinitionByRole(
  definitions: AgentDefinition[],
  role: string,
): AgentDefinition | undefined {
  return definitions.find((d) => hasRole(d, role));
}

/** Definitions a ticket can be routed to. */
export function workerDefinitions(definitions: AgentDefinition[]): AgentDefinition[] {
  return definitions.filter((d) => !PIPELINE_ROLES.some((role) => hasRole(d, role)));
}

/** Jira tickets start with the user's triage skill; typed tasks have no key to triage. */
export function triagePrompt(task: Task): string {
  return `/triage ${task.id}`;
}

function ticketHeader(task: Task): string {
  const lines = [task.source === 'jira' ? `Ticket ${task.id}: ${task.summary}` : task.summary];
  if (task.url) lines.push(task.url);
  if (task.description) lines.push('', task.description);
  return lines.join('\n');
}

export function routerPrompt(
  task: Task,
  workers: AgentDefinition[],
  busy: (name: string) => boolean,
): string {
  const index = workers.map((d) => {
    const parts = [`role: ${d.role}`];
    if (d.bestAt) parts.push(`best at: ${d.bestAt}`);
    if (d.tags?.length) parts.push(`tags: ${d.tags.join(', ')}`);
    parts.push(busy(d.name) ? 'busy' : 'available');
    return `- ${d.name} (${parts.join('; ')})`;
  });
  return [
    'Pick the one agent best suited to this ticket.',
    '',
    'Agents:',
    ...index,
    '',
    ticketHeader(task),
    ...(task.triage ? ['', 'Triage:', task.triage] : []),
    '',
    'Answer with only one line of JSON and nothing else:',
    '{"agent": "<an exact name from the list, or none>", "reason": "<one short line>"}',
  ].join('\n');
}

export interface RouterPick {
  /** Exact definition name, or null when the router said none fits. */
  agent: string | null;
  reason: string;
}

/**
 * Read the router's answer: the last JSON object in its output that names an
 * agent. A name not in the list counts as no fit. Null when nothing parses.
 */
export function parseRouterAnswer(output: string, workers: AgentDefinition[]): RouterPick | null {
  const objects = output.match(/\{[^{}]*\}/g) ?? [];
  for (const candidate of objects.reverse()) {
    let parsed: { agent?: unknown; reason?: unknown };
    try {
      parsed = JSON.parse(candidate) as typeof parsed;
    } catch {
      continue;
    }
    if (typeof parsed.agent !== 'string') continue;
    const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : '';
    const wanted = parsed.agent.trim().toLowerCase();
    const match = workers.find((d) => d.name.toLowerCase() === wanted);
    return { agent: match?.name ?? null, reason };
  }
  return null;
}

/**
 * The worker's first prompt. The human gate is stated here until phase 4
 * enforces it in the office: nothing may leave the machine.
 */
export function workerPrompt(task: Task): string {
  return [
    ticketHeader(task),
    ...(task.triage ? ['', 'Triage:', task.triage] : []),
    '',
    task.source === 'jira'
      ? 'Work on this ticket in this repository. Read the full ticket, its comments and links through the Jira MCP server when you need more than the summary.'
      : 'Work on this task in this repository.',
    'Commit on a local branch named after the ticket.',
    'Do not push, merge, open pull requests, or comment on or transition the Jira ticket: a human approves everything that leaves this machine.',
    'When the work is ready for review, stop and reply with a short summary of what you changed and how you checked it.',
  ].join('\n');
}
