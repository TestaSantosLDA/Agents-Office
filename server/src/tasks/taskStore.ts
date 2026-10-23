/**
 * The task queue's persistence: every task in `~/.pixel-agents/tasks.json`,
 * written atomically on each change. In memory it is an ordered map (oldest
 * first) that tells a listener about every write, so the server can broadcast
 * `taskUpdated` without the callers remembering to.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { Task, TaskState } from '../../../core/src/messages.js';
import { LAYOUT_FILE_DIR } from '../constants.js';

export const TASKS_FILE_NAME = 'tasks.json';

export const TASK_STATES: readonly TaskState[] = [
  'inbox',
  'triage',
  'routing',
  'working',
  'review',
  'done',
];

export function tasksFilePath(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, TASKS_FILE_NAME);
}

function isTask(raw: unknown): raw is Task {
  if (typeof raw !== 'object' || raw === null) return false;
  const t = raw as Record<string, unknown>;
  return (
    typeof t.id === 'string' &&
    typeof t.summary === 'string' &&
    typeof t.state === 'string' &&
    TASK_STATES.includes(t.state as TaskState)
  );
}

export class TaskStore {
  private readonly tasks = new Map<string, Task>();
  private nextManualId = 1;

  constructor(
    private readonly onChange: (task: Task) => void = () => {},
    private readonly file: string = tasksFilePath(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Read the file. A run that was in flight when the server stopped cannot be
   * resumed (its process is gone), and neither can an agent's PTY: both come
   * back held with a note, so nothing restarts behind the user's back.
   */
  load(): void {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
    } catch {
      return;
    }
    const list = Array.isArray((raw as { tasks?: unknown })?.tasks)
      ? (raw as { tasks: unknown[] }).tasks
      : [];
    for (const item of list) {
      if (!isTask(item)) continue;
      const task: Task = { ...item };
      if (task.running) {
        delete task.running;
        task.hold = true;
        task.attention = `The ${task.state} step was interrupted when the server stopped.`;
      }
      if (task.state === 'working') {
        delete task.agentId;
        task.state = 'routing';
        task.hold = true;
        task.attention = 'The agent ended when the server stopped.';
      }
      this.tasks.set(task.id, task);
      const n = /^task-(\d+)$/.exec(task.id);
      if (n) this.nextManualId = Math.max(this.nextManualId, Number(n[1]) + 1);
    }
  }

  list(): Task[] {
    return [...this.tasks.values()];
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  has(id: string): boolean {
    return this.tasks.has(id);
  }

  newManualId(): string {
    return `task-${this.nextManualId++}`;
  }

  /** Insert a new task (state, timestamps and `seen` filled in). */
  add(task: Omit<Task, 'createdAt' | 'updatedAt'>): Task {
    const at = this.now().toISOString();
    const created: Task = { seen: false, ...task, createdAt: at, updatedAt: at };
    this.tasks.set(created.id, created);
    this.save();
    this.onChange(created);
    return created;
  }

  /**
   * Apply a change. `undefined` values delete the field, so a step can clear
   * `running` or `attention` in the same call that sets something else.
   */
  update(id: string, patch: Partial<Task>): Task | undefined {
    const current = this.tasks.get(id);
    if (!current) return undefined;
    const next: Task = { ...current };
    for (const [key, value] of Object.entries(patch) as [keyof Task, unknown][]) {
      if (value === undefined) delete next[key];
      else (next as unknown as Record<string, unknown>)[key] = value;
    }
    next.updatedAt = this.now().toISOString();
    this.tasks.set(id, next);
    this.save();
    this.onChange(next);
    return next;
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ tasks: this.list() }, null, 2), 'utf-8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error(`[Pixel Agents] Could not write ${this.file}: ${String(err)}`);
    }
  }
}
