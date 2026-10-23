import { useEffect, useState } from 'react';

import type { AgentDefinition, Task, TaskState } from '../../../core/src/messages.js';
import type { Directory } from '../hooks/useExtensionMessages.js';
import type { TasksController } from '../hooks/useTasks.js';
import { transport } from '../transport/index.js';
import { Button } from './ui/Button.js';
import { Modal } from './ui/Modal.js';

interface TasksPanelProps {
  isOpen: boolean;
  onClose: () => void;
  tasks: TasksController;
  definitions: AgentDefinition[];
  directories: Directory[];
  /** Raise a working task's agent (its terminal). */
  onOpenAgent: (agentId: number) => void;
}

const STATES: { state: TaskState; label: string }[] = [
  { state: 'inbox', label: 'Inbox' },
  { state: 'triage', label: 'Triage' },
  { state: 'routing', label: 'Routing' },
  { state: 'working', label: 'Working' },
  { state: 'review', label: 'Review' },
  { state: 'done', label: 'Done' },
];

const RUNNING_LABEL: Record<string, string> = {
  triage: 'Triaging…',
  routing: 'Routing…',
};

const inputClass = 'text-sm py-2 px-4 bg-bg border-2 border-border rounded-none text-text';

/**
 * The queue: every task by pipeline state, the inboxes with their Refresh
 * buttons, and a line to type a task. Opening it marks everything seen, which
 * turns the mailbox light off.
 */
export function TasksPanel({
  isOpen,
  onClose,
  tasks,
  definitions,
  directories,
  onOpenAgent,
}: TasksPanelProps) {
  const [summary, setSummary] = useState('');
  const [directoryPath, setDirectoryPath] = useState('');

  // Seen while open, including tasks that arrive while it is open.
  useEffect(() => {
    if (isOpen && tasks.unseenCount > 0) transport.send({ type: 'markTasksSeen' });
  }, [isOpen, tasks.unseenCount]);

  const addTask = () => {
    if (!summary.trim()) return;
    transport.send({
      type: 'createTask',
      summary: summary.trim(),
      ...(directoryPath ? { directoryPath } : {}),
    });
    setSummary('');
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Tasks"
      zIndex={52}
      className="w-[min(720px,100%)]"
    >
      <div data-testid="tasks-panel" className="flex flex-col gap-12 px-10 py-4">
        <section className="flex flex-col gap-4">
          {tasks.inboxes.map((inbox) => {
            const note = tasks.refreshNotes[inbox.id];
            return (
              <div key={inbox.id} className="flex items-center gap-8 flex-wrap">
                <span className="text-sm">{inbox.name}</span>
                <Button
                  size="sm"
                  variant={tasks.refreshing[inbox.id] ? 'disabled' : 'default'}
                  disabled={tasks.refreshing[inbox.id]}
                  onClick={() => tasks.refresh(inbox.id)}
                >
                  {tasks.refreshing[inbox.id] ? 'Refreshing…' : 'Refresh'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => tasks.openInbox(inbox)}>
                  Edit
                </Button>
                {note && (
                  <span className={`text-xs ${note.error ? 'text-danger' : 'text-text-muted'}`}>
                    {note.error ?? (note.added === 0 ? 'Nothing new.' : `${note.added} new`)}
                  </span>
                )}
              </div>
            );
          })}
          <div>
            <Button size="sm" variant="ghost" onClick={() => tasks.openInbox(null)}>
              + Jira inbox
            </Button>
          </div>
        </section>

        <section className="flex items-center gap-8 flex-wrap">
          <input
            type="text"
            value={summary}
            placeholder="Type a task"
            onChange={(e) => setSummary(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addTask();
              }
            }}
            className={`${inputClass} flex-1 min-w-[160px]`}
          />
          <select
            value={directoryPath}
            onChange={(e) => setDirectoryPath(e.target.value)}
            className={inputClass}
            title="Directory"
          >
            <option value="">Agent’s Directory</option>
            {directories.map((d) => (
              <option key={d.path} value={d.path}>
                {d.name}
              </option>
            ))}
          </select>
          <Button size="sm" variant="accent" onClick={addTask}>
            + Task
          </Button>
        </section>

        {tasks.tasks.length === 0 && (
          <p className="text-sm text-text-muted m-0">
            No tasks yet. Refresh an inbox or type one above.
          </p>
        )}

        {STATES.map(({ state, label }) => {
          const inState = tasks.tasks.filter((t) => t.state === state);
          if (inState.length === 0) return null;
          const rows = inState.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              definitions={definitions}
              onOpenAgent={onOpenAgent}
            />
          ));
          // Done piles up; keep it folded.
          return state === 'done' ? (
            <details key={state} data-testid="tasks-done">
              <summary className="text-xs text-text-muted cursor-pointer">
                {label} ({inState.length})
              </summary>
              <div className="flex flex-col gap-4 pt-4">{rows}</div>
            </details>
          ) : (
            <section key={state} data-testid={`tasks-${state}`} className="flex flex-col gap-4">
              <span className="text-xs text-text-muted">
                {label} ({inState.length})
              </span>
              {rows}
            </section>
          );
        })}
      </div>
    </Modal>
  );
}

function TaskRow({
  task,
  definitions,
  onOpenAgent,
}: {
  task: Task;
  definitions: AgentDefinition[];
  onOpenAgent: (agentId: number) => void;
}) {
  const busy = task.running !== undefined;
  return (
    <div data-testid="task-row" className="flex flex-col gap-2 border-2 border-border p-6">
      <div className="flex items-baseline gap-8 flex-wrap">
        {task.source === 'jira' &&
          (task.url ? (
            <a
              href={task.url}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-accent-bright"
            >
              {task.id}
            </a>
          ) : (
            <span className="text-sm text-accent-bright">{task.id}</span>
          ))}
        <span className="text-sm flex-1 min-w-0">{task.summary}</span>
        {task.running && (
          <span className="text-xs text-status-active">{RUNNING_LABEL[task.running] ?? '…'}</span>
        )}
        {task.assignee && (
          <span className="text-xs text-text-muted">
            → {task.assignee}
            {task.flagged ? ' (no specialist)' : ''}
          </span>
        )}
      </div>
      {task.dispatchNote && <span className="text-xs text-text-muted">{task.dispatchNote}</span>}
      {task.attention && (
        <span role="status" className="text-xs text-warning">
          {task.attention}
        </span>
      )}
      {task.triage && (
        <details>
          <summary className="text-xs text-text-muted cursor-pointer">Triage</summary>
          <pre className="text-xs whitespace-pre-wrap m-0 max-h-160 overflow-y-auto pixel-scrollbar">
            {task.triage}
          </pre>
        </details>
      )}
      <div className="flex items-center gap-8 flex-wrap pt-2">
        {task.hold && !busy && (
          <Button
            size="sm"
            variant="accent"
            onClick={() => transport.send({ type: 'startTask', taskId: task.id })}
          >
            Start
          </Button>
        )}
        {task.state === 'working' && task.agentId !== undefined && (
          <Button size="sm" onClick={() => onOpenAgent(task.agentId!)}>
            Open terminal
          </Button>
        )}
        {!busy && task.state !== 'working' && definitions.length > 0 && (
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) {
                transport.send({
                  type: 'assignTask',
                  taskId: task.id,
                  definitionName: e.target.value,
                });
              }
            }}
            className={inputClass}
            aria-label="Assign to"
          >
            <option value="">Assign to…</option>
            {definitions.map((d) => (
              <option key={d.name} value={d.name}>
                {d.name}
              </option>
            ))}
          </select>
        )}
        {!busy && (
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) {
                transport.send({
                  type: 'moveTask',
                  taskId: task.id,
                  state: e.target.value as TaskState,
                });
              }
            }}
            className={inputClass}
            aria-label="Move to"
          >
            <option value="">Move to…</option>
            {STATES.filter((s) => s.state !== task.state && s.state !== 'working').map((s) => (
              <option key={s.state} value={s.state}>
                {s.label}
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}
