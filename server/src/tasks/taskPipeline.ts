/**
 * The standalone host's task queue, put together: the TaskStore broadcasts
 * every change, the TaskEngine launches agents through the same launcher as
 * the drawer, and agent status from the store moves tasks along.
 *
 * Also the task and inbox client messages, shaped like agentMessages.ts:
 * returns false for anything else so the host's switch stays intact.
 */

import type { TaskState } from '../../../core/src/messages.js';
import type { AgentRuntime } from '../agentRuntime.js';
import { listAgentDefinitions } from '../agents/agentDefinitions.js';
import { countAgentsWithDefinition, prepareDefinitionLaunch } from '../agents/agentMessages.js';
import type { AgentStateStore } from '../agentStateStore.js';
import { listDirectories, validateDirectoryPath } from '../directories.js';
import { hostDirectory } from '../hostDirectory.js';
import { claudeProvider } from '../providers/index.js';
import type { PtySessionManager } from '../terminal/ptySessionManager.js';
import { launchStandaloneAgent } from '../terminal/standaloneAgentLauncher.js';
import { createHeadlessRunner } from './headlessRunner.js';
import {
  fetchJiraIssues,
  listInboxSummaries,
  markInboxRefreshed,
  readInboxes,
  removeInbox,
  saveInbox,
} from './inboxes.js';
import { TaskEngine } from './taskEngine.js';
import { TASK_STATES, TaskStore } from './taskStore.js';

const KEY_BYPASS_PERMISSIONS = 'pixel-agents.bypassPermissions';

/** Messages that carry ticket text: never sent to a read-only office. */
export const TASK_BROADCAST_TYPES: ReadonlySet<string> = new Set([
  'tasksLoaded',
  'taskUpdated',
  'inboxesLoaded',
]);

export function createTaskPipeline(deps: {
  store: AgentStateStore;
  runtime: AgentRuntime;
  ptyManager: PtySessionManager;
}): TaskEngine {
  const { store, runtime, ptyManager } = deps;
  const bypass = () => store.getAdapter()?.getSetting(KEY_BYPASS_PERMISSIONS, false) ?? false;
  const skillDirectories = () =>
    listDirectories([hostDirectory()]).map((d) => ({ name: d.name, path: d.path }));

  const tasks = new TaskStore((task) => store.broadcast({ type: 'taskUpdated', task }));
  tasks.load();

  const engine = new TaskEngine({
    tasks,
    definitions: listAgentDefinitions,
    prepare: (definitionName, requestedPath) =>
      prepareDefinitionLaunch({
        definitionName,
        requestedPath,
        fallbackPath: hostDirectory().path,
        running: (name) => countAgentsWithDefinition(store, name),
        skillDirectories: skillDirectories(),
      }),
    launch: (prepared, initialPrompt) =>
      launchStandaloneAgent(
        { store, runtime, ptyManager, provider: claudeProvider },
        {
          directoryPath: prepared.directoryPath,
          bypassPermissions: bypass(),
          profile: { ...prepared.profile, initialPrompt },
          definitionName: prepared.definitionName,
        },
      ),
    runHeadless: createHeadlessRunner(claudeProvider, bypass),
    readInboxes,
    fetchIssues: (inbox) => fetchJiraIssues(inbox),
    markInboxRefreshed,
  });

  store.on('broadcast', (message: Record<string, unknown>) => {
    if (message.type !== 'agentStatus' || typeof message.id !== 'number') return;
    engine.onAgentStatus(message.id, String(message.status), message.awaitingInput === true);
  });
  store.on('agentRemoved', (id: number) => engine.onAgentRemoved(id));

  // Anything left waiting from the last run (and not held) moves now.
  engine.pump();
  return engine;
}

export function taskSnapshotMessages(engine: TaskEngine): Record<string, unknown>[] {
  return [
    { type: 'tasksLoaded', tasks: engine.tasks.list() },
    { type: 'inboxesLoaded', inboxes: listInboxSummaries() },
  ];
}

function inboxesLoaded(): Record<string, unknown> {
  return { type: 'inboxesLoaded', inboxes: listInboxSummaries() };
}

export function handleTaskClientMessage(
  msg: Record<string, unknown>,
  deps: {
    engine: TaskEngine;
    broadcast: (message: Record<string, unknown>) => void;
    reply: (message: Record<string, unknown>) => void;
  },
): boolean {
  const { engine } = deps;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  switch (msg.type) {
    case 'saveInbox': {
      const result = saveInbox((msg.inbox ?? {}) as Parameters<typeof saveInbox>[0]);
      if (!result.ok) deps.reply({ type: 'inboxRejected', reason: result.reason });
      else deps.broadcast(inboxesLoaded());
      return true;
    }
    case 'removeInbox': {
      const result = removeInbox(str(msg.id));
      if (!result.ok) deps.reply({ type: 'inboxRejected', reason: result.reason });
      else deps.broadcast(inboxesLoaded());
      return true;
    }
    case 'refreshInbox': {
      const inboxId = str(msg.inboxId);
      void engine.refreshInbox(inboxId).then((result) => {
        deps.reply({
          type: 'inboxRefreshed',
          inboxId,
          added: result.ok ? result.value : 0,
          ...(result.ok ? {} : { error: result.reason }),
        });
        if (result.ok) deps.broadcast(inboxesLoaded());
      });
      return true;
    }
    case 'createTask': {
      let directoryPath: string | undefined;
      if (str(msg.directoryPath).trim()) {
        const checked = validateDirectoryPath(str(msg.directoryPath));
        if (!checked.ok) return true;
        directoryPath = checked.path;
      }
      engine.createTask({
        summary: str(msg.summary),
        description: str(msg.description) || undefined,
        directoryPath,
      });
      return true;
    }
    case 'startTask':
      engine.startTask(str(msg.taskId));
      return true;
    case 'assignTask':
      engine.assignTask(str(msg.taskId), str(msg.definitionName));
      return true;
    case 'moveTask':
      if (TASK_STATES.includes(msg.state as TaskState)) {
        engine.moveTask(str(msg.taskId), msg.state as TaskState);
      }
      return true;
    case 'markTasksSeen':
      engine.markAllSeen();
      return true;
    default:
      return false;
  }
}
