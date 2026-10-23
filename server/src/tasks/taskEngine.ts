/**
 * The pipeline: inbox → triage → routing → working → review → done.
 *
 * - **Triage**: Jira tickets go to the Agent definition with role `triage`
 *   first, as a headless `/triage <KEY>` run; its output travels with the task.
 * - **Routing**: the definition with role `router` gets the ticket, the triage
 *   and the agent index as one headless prompt and names one agent. No fit
 *   sends it to the `generalist` (flagged), or holds it for a manual pick.
 * - **Dispatch**: the chosen definition is launched as a normal agent (PTY,
 *   seat, terminal) with the ticket as its first prompt.
 * - **Review**: when that agent finishes its turn, the task moves to review.
 *   Nothing leaves the machine from there without a click (phase 4).
 *
 * At most `maxConcurrent` steps run at once: headless runs in flight plus
 * tasks being worked on. Everything else waits its turn, oldest first.
 * State changes are instant; the office animates after them.
 */

import type { AgentDefinition, Task, TaskState } from '../../../core/src/messages.js';
import type { LaunchProfile } from '../../../core/src/provider.js';
import type { DefinitionLaunch } from '../agents/agentMessages.js';
import type { HeadlessRun } from './headlessRunner.js';
import type { FetchedIssue, InboxResult, StoredInbox } from './inboxes.js';
import {
  findDefinitionByRole,
  GENERALIST_ROLE,
  parseRouterAnswer,
  ROUTER_ROLE,
  routerPrompt,
  TRIAGE_ROLE,
  triagePrompt,
  workerDefinitions,
  workerPrompt,
} from './prompts.js';
import { TASK_STATES, type TaskStore } from './taskStore.js';

/** Standing decision: three sessions at once; measure before changing. */
export const DISPATCHER_MAX_CONCURRENT = 3;

export const PRE_EXISTING_NOTE =
  'Already assigned when the inbox was first refreshed. Start it when you want it worked on.';
const AWAITING_INPUT_NOTE = 'The agent is waiting for your answer in its terminal.';

export interface TaskEngineDeps {
  tasks: TaskStore;
  definitions: () => AgentDefinition[];
  /** Decide Directory, cap and profile for a definition (see prepareDefinitionLaunch). */
  prepare: (definitionName: string, requestedPath: string | undefined) => DefinitionLaunch;
  /** Launch an agent; returns its id, or null when nothing was spawned. */
  launch: (launch: Extract<DefinitionLaunch, { ok: true }>, initialPrompt: string) => number | null;
  runHeadless: HeadlessRun;
  readInboxes: () => StoredInbox[];
  fetchIssues: (inbox: StoredInbox) => Promise<InboxResult<FetchedIssue[]>>;
  markInboxRefreshed: (id: string, at: Date) => void;
  maxConcurrent?: number;
  now?: () => Date;
}

export class TaskEngine {
  private readonly maxConcurrent: number;
  private readonly now: () => Date;
  private readonly refreshing = new Set<string>();

  constructor(private readonly deps: TaskEngineDeps) {
    this.maxConcurrent = deps.maxConcurrent ?? DISPATCHER_MAX_CONCURRENT;
    this.now = deps.now ?? (() => new Date());
  }

  get tasks(): TaskStore {
    return this.deps.tasks;
  }

  // ── Inputs ────────────────────────────────────────────────────

  async refreshInbox(inboxId: string): Promise<InboxResult<number>> {
    const inbox = this.deps.readInboxes().find((i) => i.id === inboxId);
    if (!inbox) return { ok: false, reason: 'That inbox no longer exists.' };
    if (this.refreshing.has(inboxId)) return { ok: false, reason: 'Already refreshing.' };
    this.refreshing.add(inboxId);
    let fetched: InboxResult<FetchedIssue[]>;
    try {
      fetched = await this.deps.fetchIssues(inbox);
    } finally {
      this.refreshing.delete(inboxId);
    }
    if (!fetched.ok) return fetched;
    // The first refresh imports what is already assigned, held, so the
    // router does not chew through a backlog.
    const firstRefresh = !inbox.lastRefreshAt;
    let added = 0;
    // Oldest first, so the queue order follows Jira's.
    for (const issue of [...fetched.value].reverse()) {
      if (this.deps.tasks.has(issue.key)) continue;
      this.deps.tasks.add({
        id: issue.key,
        source: 'jira',
        inboxId: inbox.id,
        summary: issue.summary,
        url: issue.url,
        ...(inbox.directoryPath ? { directoryPath: inbox.directoryPath } : {}),
        state: 'inbox',
        ...(firstRefresh ? { hold: true, attention: PRE_EXISTING_NOTE } : {}),
      });
      added++;
    }
    this.deps.markInboxRefreshed(inbox.id, this.now());
    this.pump();
    return { ok: true, value: added };
  }

  createTask(input: {
    summary: string;
    description?: string;
    directoryPath?: string;
  }): Task | null {
    const summary = input.summary.trim();
    if (!summary) return null;
    const task = this.deps.tasks.add({
      id: this.deps.tasks.newManualId(),
      source: 'manual',
      summary,
      ...(input.description?.trim() ? { description: input.description.trim() } : {}),
      ...(input.directoryPath ? { directoryPath: input.directoryPath } : {}),
      state: 'inbox',
      // Typed here, so it is seen already.
      seen: true,
    });
    this.pump();
    return task;
  }

  startTask(taskId: string): void {
    const task = this.deps.tasks.get(taskId);
    if (!task || task.running) return;
    this.deps.tasks.update(taskId, { hold: undefined, attention: undefined });
    this.pump();
  }

  /** A manual pick: skip triage and routing, dispatch when a slot is free. */
  assignTask(taskId: string, definitionName: string): void {
    const task = this.deps.tasks.get(taskId);
    const definition = this.deps
      .definitions()
      .find((d) => d.name.toLowerCase() === definitionName.trim().toLowerCase());
    if (!task || !definition || task.running || task.state === 'working') return;
    this.deps.tasks.update(taskId, {
      state: 'routing',
      assignee: definition.name,
      dispatchNote: 'Assigned by hand.',
      flagged: undefined,
      hold: undefined,
      attention: undefined,
    });
    this.pump();
  }

  moveTask(taskId: string, state: TaskState): void {
    const task = this.deps.tasks.get(taskId);
    if (!task || task.running || !TASK_STATES.includes(state)) return;
    const patch: Partial<Task> = { state, attention: undefined };
    // A hand move into a step means "redo it"; the pipeline waits for Start.
    if (state === 'inbox' || state === 'triage' || state === 'routing') patch.hold = true;
    if (state !== 'working') patch.agentId = undefined;
    if (state === 'routing') patch.assignee = undefined;
    if (state === 'inbox' || state === 'triage') {
      patch.triage = undefined;
      patch.assignee = undefined;
      patch.dispatchNote = undefined;
      patch.flagged = undefined;
    }
    this.deps.tasks.update(taskId, patch);
    this.pump();
  }

  markAllSeen(): void {
    for (const task of this.deps.tasks.list()) {
      if (task.seen === false) this.deps.tasks.update(task.id, { seen: true });
    }
  }

  // ── Agent signals ─────────────────────────────────────────────

  /** Feed every agentStatus broadcast through here. */
  onAgentStatus(agentId: number, status: string, awaitingInput: boolean): void {
    const task = this.taskForAgent(agentId);
    if (!task) return;
    if (status === 'active') {
      if (task.attention === AWAITING_INPUT_NOTE) {
        this.deps.tasks.update(task.id, { attention: undefined });
      }
      return;
    }
    if (status !== 'waiting') return;
    if (awaitingInput) {
      this.deps.tasks.update(task.id, { attention: AWAITING_INPUT_NOTE });
      return;
    }
    // The agent finished its turn: the work is ready for review. Its session
    // stays open for questions and for the review loop.
    this.deps.tasks.update(task.id, { state: 'review', attention: undefined });
    this.pump();
  }

  onAgentRemoved(agentId: number): void {
    const task = this.taskForAgent(agentId);
    if (!task) return;
    this.deps.tasks.update(task.id, {
      state: 'routing',
      agentId: undefined,
      hold: true,
      attention: 'The agent was closed before it finished. Start to dispatch it again.',
    });
    this.pump();
  }

  private taskForAgent(agentId: number): Task | undefined {
    return this.deps.tasks.list().find((t) => t.state === 'working' && t.agentId === agentId);
  }

  // ── The pump ──────────────────────────────────────────────────

  private inFlight(): number {
    return this.deps.tasks.list().filter((t) => t.running || t.state === 'working').length;
  }

  private hasSlot(): boolean {
    return this.inFlight() < this.maxConcurrent;
  }

  /**
   * Advance every task that can move. Steps that need no session (deciding
   * there is no triage, holding for a manual pick) happen at once; steps that
   * start a session wait for a free slot.
   */
  pump(): void {
    for (const task of this.deps.tasks.list()) {
      if (task.hold || task.running) continue;
      if (task.state === 'inbox' || task.state === 'triage' || task.state === 'routing') {
        this.advance(task);
      }
    }
  }

  private advance(task: Task): void {
    const definitions = this.deps.definitions();
    if (task.state === 'inbox' || task.state === 'triage') {
      const triage = findDefinitionByRole(definitions, TRIAGE_ROLE);
      if (task.source !== 'jira' || !triage || task.triage) {
        this.deps.tasks.update(task.id, { state: 'routing' });
        this.advance(this.deps.tasks.get(task.id)!);
        return;
      }
      if (this.hasSlot()) void this.runTriage(task, triage);
      return;
    }
    // routing
    if (task.assignee) {
      if (this.hasSlot()) this.dispatch(task, task.assignee);
      return;
    }
    const workers = workerDefinitions(definitions);
    if (workers.length === 0) {
      this.hold(task, 'No agents to route to yet. Create one with + New agent.');
      return;
    }
    const router = findDefinitionByRole(definitions, ROUTER_ROLE);
    if (!router) {
      if (workers.length === 1) {
        this.deps.tasks.update(task.id, {
          assignee: workers[0].name,
          dispatchNote: 'The only agent.',
        });
        if (this.hasSlot()) this.dispatch(this.deps.tasks.get(task.id)!, workers[0].name);
      } else {
        this.hold(task, 'No router agent (role: router). Assign this task by hand.');
      }
      return;
    }
    if (this.hasSlot()) void this.runRouter(task, router, workers);
  }

  private hold(task: Task, attention: string): void {
    this.deps.tasks.update(task.id, { hold: true, attention });
  }

  private headlessProfile(
    definition: AgentDefinition,
    task: Task,
  ): { cwd: string; profile: LaunchProfile } | { reason: string } {
    const prepared = this.deps.prepare(definition.name, task.directoryPath);
    if (prepared.ok) return { cwd: prepared.directoryPath, profile: prepared.profile };
    // The ticket's Directory is not one the step's agent allows: run it in the
    // agent's own Directory instead; triage and routing only read.
    const fallback = this.deps.prepare(definition.name, undefined);
    return fallback.ok ? { cwd: fallback.directoryPath, profile: fallback.profile } : fallback;
  }

  private async runTriage(task: Task, triage: AgentDefinition): Promise<void> {
    const where = this.headlessProfile(triage, task);
    if ('reason' in where) {
      this.hold(task, `Triage could not start: ${where.reason}`);
      return;
    }
    this.deps.tasks.update(task.id, { state: 'triage', running: 'triage' });
    const result = await this.deps.runHeadless(triagePrompt(task), where.cwd, where.profile);
    if (!result.ok) {
      this.deps.tasks.update(task.id, {
        running: undefined,
        hold: true,
        attention: `Triage failed: ${result.reason}`,
      });
    } else {
      this.deps.tasks.update(task.id, {
        running: undefined,
        state: 'routing',
        triage: result.output,
      });
    }
    this.pump();
  }

  private async runRouter(
    task: Task,
    router: AgentDefinition,
    workers: AgentDefinition[],
  ): Promise<void> {
    const where = this.headlessProfile(router, task);
    if ('reason' in where) {
      this.hold(task, `Routing could not start: ${where.reason}`);
      return;
    }
    const working = new Set(
      this.deps.tasks
        .list()
        .filter((t) => t.state === 'working' && t.assignee)
        .map((t) => t.assignee!.toLowerCase()),
    );
    this.deps.tasks.update(task.id, { running: 'routing' });
    const result = await this.deps.runHeadless(
      routerPrompt(task, workers, (name) => working.has(name.toLowerCase())),
      where.cwd,
      where.profile,
    );
    if (!result.ok) {
      this.deps.tasks.update(task.id, {
        running: undefined,
        hold: true,
        attention: `Routing failed: ${result.reason}`,
      });
      this.pump();
      return;
    }
    const pick = parseRouterAnswer(result.output, workers);
    if (pick?.agent) {
      this.deps.tasks.update(task.id, {
        running: undefined,
        assignee: pick.agent,
        dispatchNote: pick.reason || undefined,
        flagged: undefined,
      });
    } else {
      // No fit: the generalist takes it, flagged, which is how a missing
      // specialist gets noticed. Without one, a human picks.
      const generalist = findDefinitionByRole(workers, GENERALIST_ROLE);
      const why = pick
        ? `No specialist fits${pick.reason ? `: ${pick.reason}` : '.'}`
        : 'The router gave no usable answer.';
      this.deps.tasks.update(task.id, {
        running: undefined,
        flagged: true,
        ...(generalist
          ? { assignee: generalist.name, dispatchNote: why }
          : { hold: true, dispatchNote: why, attention: `${why} Assign it by hand.` }),
      });
    }
    this.pump();
  }

  private dispatch(task: Task, definitionName: string): void {
    const prepared = this.deps.prepare(definitionName, task.directoryPath);
    if (!prepared.ok) {
      // A full cap on the definition itself waits; anything else needs a human.
      if (/already running/.test(prepared.reason)) {
        const waiting = `Waiting: ${prepared.reason} Close one of its sessions to free it.`;
        if (task.attention !== waiting) this.deps.tasks.update(task.id, { attention: waiting });
        return;
      }
      this.hold(task, `Could not dispatch to ${definitionName}: ${prepared.reason}`);
      return;
    }
    const agentId = this.deps.launch(prepared, workerPrompt(task));
    if (agentId === null) {
      this.hold(task, `Could not launch ${definitionName}; see the server log.`);
      return;
    }
    this.deps.tasks.update(task.id, {
      state: 'working',
      agentId,
      directoryPath: task.directoryPath ?? prepared.directoryPath,
      attention: undefined,
    });
  }
}
