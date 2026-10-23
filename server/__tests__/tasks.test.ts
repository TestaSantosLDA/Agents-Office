import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentDefinition, Task } from '../../core/src/messages.js';
import type { DefinitionLaunch } from '../src/agents/agentMessages.js';
import { claudeProvider } from '../src/providers/index.js';
import type { HeadlessResult } from '../src/tasks/headlessRunner.js';
import {
  buildJql,
  type FetchedIssue,
  fetchJiraIssues,
  inboxesFilePath,
  type InboxResult,
  listInboxSummaries,
  readInboxes,
  saveInbox,
  type StoredInbox,
} from '../src/tasks/inboxes.js';
import {
  parseRouterAnswer,
  routerPrompt,
  workerDefinitions,
  workerPrompt,
} from '../src/tasks/prompts.js';
import { PRE_EXISTING_NOTE, TaskEngine } from '../src/tasks/taskEngine.js';
import { TaskStore } from '../src/tasks/taskStore.js';

/**
 * The task queue (Agent Office phase 3): persistence, Jira inboxes, the
 * pipeline prompts, and the engine that moves tasks from inbox to review.
 * $HOME is redirected to a fresh temp dir per test.
 */

const def = (
  name: string,
  role: string,
  extra: Partial<AgentDefinition> = {},
): AgentDefinition => ({
  name,
  role,
  ...extra,
});

let tempHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  tempHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-tasks-test-')));
  originalHome = process.env.HOME;
  process.env.HOME = tempHome;
});

afterEach(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

describe('TaskStore', () => {
  it('persists, deletes fields patched with undefined, and numbers typed tasks', () => {
    const file = path.join(tempHome, 'tasks.json');
    const changes: Task[] = [];
    const store = new TaskStore((t) => changes.push(t), file);
    const id = store.newManualId();
    store.add({ id, source: 'manual', summary: 'Fix it', state: 'inbox', attention: 'x' });
    store.update(id, { attention: undefined, state: 'routing' });

    expect(changes).toHaveLength(2);
    const saved = JSON.parse(fs.readFileSync(file, 'utf-8')).tasks[0];
    expect(saved).toMatchObject({ id: 'task-1', state: 'routing', seen: false });
    expect(saved.attention).toBeUndefined();

    const reloaded = new TaskStore(() => {}, file);
    reloaded.load();
    expect(reloaded.newManualId()).toBe('task-2');
  });

  it('holds work interrupted by a server stop instead of resuming it', () => {
    const file = path.join(tempHome, 'tasks.json');
    const at = new Date().toISOString();
    fs.writeFileSync(
      file,
      JSON.stringify({
        tasks: [
          {
            id: 'A-1',
            source: 'jira',
            summary: 'a',
            state: 'triage',
            running: 'triage',
            createdAt: at,
            updatedAt: at,
          },
          {
            id: 'A-2',
            source: 'jira',
            summary: 'b',
            state: 'working',
            agentId: 4,
            createdAt: at,
            updatedAt: at,
          },
          { id: 'bad', state: 'nope' },
        ],
      }),
    );
    const store = new TaskStore(() => {}, file);
    store.load();
    expect(store.list().map((t) => t.id)).toEqual(['A-1', 'A-2']);
    expect(store.get('A-1')).toMatchObject({ hold: true, state: 'triage' });
    expect(store.get('A-1')?.running).toBeUndefined();
    expect(store.get('A-2')).toMatchObject({ hold: true, state: 'routing' });
    expect(store.get('A-2')?.agentId).toBeUndefined();
  });
});

describe('inboxes', () => {
  const input = {
    name: 'Work',
    provider: 'jira' as const,
    baseUrl: 'https://team.atlassian.net/jira/your-work',
    email: 'me@example.com',
    apiToken: 'secret',
  };

  it('stores the token 0600 and never summarizes it', () => {
    const saved = saveInbox(input);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.value.baseUrl).toBe('https://team.atlassian.net');
    expect(fs.statSync(inboxesFilePath()).mode & 0o777).toBe(0o600);
    const [summary] = listInboxSummaries();
    expect(summary.hasToken).toBe(true);
    expect(JSON.stringify(summary)).not.toContain('secret');
  });

  it('keeps the stored token when an edit leaves it empty', () => {
    const saved = saveInbox(input);
    if (!saved.ok) throw new Error(saved.reason);
    const edited = saveInbox({ ...input, id: saved.value.id, name: 'Renamed', apiToken: '' });
    expect(edited.ok).toBe(true);
    expect(readInboxes()).toEqual([
      expect.objectContaining({ name: 'Renamed', apiToken: 'secret' }),
    ]);
  });

  it('refuses http, a missing email and a missing token', () => {
    expect(saveInbox({ ...input, baseUrl: 'http://team.atlassian.net' }).ok).toBe(false);
    expect(saveInbox({ ...input, email: ' ' }).ok).toBe(false);
    expect(saveInbox({ ...input, apiToken: '' }).ok).toBe(false);
  });

  it('builds the JQL on top of "assigned to me"', () => {
    expect(buildJql(undefined)).toBe('assignee = currentUser() ORDER BY updated DESC');
    expect(buildJql('project = APP')).toBe(
      'assignee = currentUser() AND (project = APP) ORDER BY updated DESC',
    );
  });

  const inbox: StoredInbox = {
    id: 'i',
    name: 'Work',
    provider: 'jira',
    baseUrl: 'https://team.atlassian.net',
    email: 'me@example.com',
    apiToken: 'secret',
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('reads key and summary across pages with basic auth', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        json({ issues: [{ key: 'APP-2', fields: { summary: 'Two' } }], nextPageToken: 'p2' }),
      )
      .mockResolvedValueOnce(
        json({ issues: [{ key: 'APP-1', fields: { summary: 'One' } }], isLast: true }),
      );
    const result = await fetchJiraIssues(inbox, fetchFn as unknown as typeof fetch);
    expect(result).toEqual({
      ok: true,
      value: [
        { key: 'APP-2', summary: 'Two', url: 'https://team.atlassian.net/browse/APP-2' },
        { key: 'APP-1', summary: 'One', url: 'https://team.atlassian.net/browse/APP-1' },
      ],
    });
    const [firstUrl, firstInit] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(firstUrl).toContain('/rest/api/3/search/jql?');
    expect(firstUrl).toContain('fields=summary');
    expect((firstInit.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from('me@example.com:secret').toString('base64')}`,
    );
    expect(fetchFn.mock.calls[1][0]).toContain('nextPageToken=p2');
  });

  it('says plainly when Jira refuses the credentials', async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({}, 401));
    const result = await fetchJiraIssues(inbox, fetchFn as unknown as typeof fetch);
    expect(result).toEqual({ ok: false, reason: 'Jira refused the email and token.' });
  });
});

describe('pipeline prompts', () => {
  const workers = [def('Rui', 'backend'), def('Ana', 'frontend'), def('General', 'generalist')];

  it('never routes to pipeline roles', () => {
    const all = [...workers, def('Router', 'router'), def('Triage', 'Triage')];
    expect(workerDefinitions(all).map((d) => d.name)).toEqual(['Rui', 'Ana', 'General']);
  });

  it('reads the last JSON answer, matching names case-insensitively', () => {
    const out =
      'Thinking {"agent": "Ana", "reason": "first"}\nFinal: {"agent": "rui", "reason": "API work"}';
    expect(parseRouterAnswer(out, workers)).toEqual({ agent: 'Rui', reason: 'API work' });
    expect(parseRouterAnswer('{"agent": "none", "reason": "no fit"}', workers)).toEqual({
      agent: null,
      reason: 'no fit',
    });
    expect(parseRouterAnswer('I am not sure.', workers)).toBeNull();
  });

  const task: Task = {
    id: 'APP-1',
    source: 'jira',
    summary: 'Add login',
    state: 'routing',
    triage: 'Needs the auth API.',
    createdAt: '',
    updatedAt: '',
  };

  it('gives the router the index, the ticket and the triage', () => {
    const prompt = routerPrompt(task, workers, (n) => n === 'Rui');
    expect(prompt).toContain('- Rui (role: backend; busy)');
    expect(prompt).toContain('- Ana (role: frontend; available)');
    expect(prompt).toContain('Ticket APP-1: Add login');
    expect(prompt).toContain('Needs the auth API.');
  });

  it('tells the worker nothing leaves the machine', () => {
    const prompt = workerPrompt(task);
    expect(prompt).toContain('Ticket APP-1: Add login');
    expect(prompt).toContain('Do not push, merge, open pull requests');
  });
});

describe('claude headless command', () => {
  it('runs the prompt in print mode with the definition profile', () => {
    const cmd = claudeProvider.buildHeadlessCommand!('/triage APP-1', '/repo', {
      bypassPermissions: false,
      profile: { model: 'sonnet', tools: ['Read', 'Grep'], appendSystemPrompt: 'You triage.' },
    });
    expect(cmd.args).toEqual([
      '-p',
      '/triage APP-1',
      '--model',
      'sonnet',
      '--tools=Read,Grep',
      '--append-system-prompt',
      'You triage.',
    ]);
  });

  it('puts an initial prompt last on an interactive launch', () => {
    const cmd = claudeProvider.buildLaunchCommand!('sid', '/repo', {
      profile: { initialPrompt: 'Ticket APP-1' },
    });
    expect(cmd.args.at(-1)).toBe('Ticket APP-1');
    expect(cmd.args.slice(0, 2)).toEqual(['--session-id', 'sid']);
  });
});

describe('TaskEngine', () => {
  interface Harness {
    engine: TaskEngine;
    store: TaskStore;
    launches: { definitionName: string; prompt: string; directoryPath: string }[];
    headless: { prompt: string; resolve: (r: HeadlessResult) => void }[];
    definitions: AgentDefinition[];
    inboxes: StoredInbox[];
    issues: FetchedIssue[];
  }

  const flush = () => new Promise((r) => setTimeout(r, 0));

  function harness(definitions: AgentDefinition[], maxConcurrent = 3): Harness {
    const h = {
      launches: [],
      headless: [],
      definitions,
      inboxes: [] as StoredInbox[],
      issues: [] as FetchedIssue[],
    } as unknown as Harness;
    h.store = new TaskStore(() => {}, path.join(tempHome, 'tasks.json'));
    let nextAgent = 1;
    h.engine = new TaskEngine({
      tasks: h.store,
      definitions: () => h.definitions,
      prepare: (definitionName, requestedPath): DefinitionLaunch => {
        const d = h.definitions.find((x) => x.name === definitionName);
        if (!d) return { ok: false, reason: `No agent called ${definitionName}.` };
        return {
          ok: true,
          definitionName: d.name,
          directoryPath: requestedPath ?? `/home/${d.name}`,
          profile: {},
        };
      },
      launch: (prepared, prompt) => {
        h.launches.push({
          definitionName: prepared.definitionName,
          prompt,
          directoryPath: prepared.directoryPath,
        });
        return nextAgent++;
      },
      runHeadless: (prompt) =>
        new Promise<HeadlessResult>((resolve) => h.headless.push({ prompt, resolve })),
      readInboxes: () => h.inboxes,
      fetchIssues: async (): Promise<InboxResult<FetchedIssue[]>> => ({
        ok: true,
        value: h.issues,
      }),
      markInboxRefreshed: (id, at) => {
        h.inboxes = h.inboxes.map((i) =>
          i.id === id ? { ...i, lastRefreshAt: at.toISOString() } : i,
        );
      },
      maxConcurrent,
    });
    return h;
  }

  const jiraInbox = (lastRefreshAt?: string): StoredInbox => ({
    id: 'work',
    name: 'Work',
    provider: 'jira',
    baseUrl: 'https://team.atlassian.net',
    email: 'me@example.com',
    apiToken: 't',
    directoryPath: '/repo',
    ...(lastRefreshAt ? { lastRefreshAt } : {}),
  });
  const issue = (key: string): FetchedIssue => ({
    key,
    summary: `Summary ${key}`,
    url: `u/${key}`,
  });

  it('holds what the first refresh imports, and pipelines later tickets', async () => {
    const h = harness([def('Rui', 'backend')]);
    h.inboxes = [jiraInbox()];
    h.issues = [issue('APP-1')];
    expect(await h.engine.refreshInbox('work')).toEqual({ ok: true, value: 1 });
    expect(h.store.get('APP-1')).toMatchObject({
      hold: true,
      attention: PRE_EXISTING_NOTE,
      state: 'inbox',
    });
    expect(h.launches).toHaveLength(0);

    h.issues = [issue('APP-2'), issue('APP-1')];
    expect(await h.engine.refreshInbox('work')).toEqual({ ok: true, value: 1 });
    // No triage agent, no router, one worker: straight to it, in the inbox's Directory.
    expect(h.store.get('APP-2')).toMatchObject({ state: 'working', assignee: 'Rui', agentId: 1 });
    expect(h.launches[0]).toMatchObject({ definitionName: 'Rui', directoryPath: '/repo' });
    expect(h.launches[0].prompt).toContain('Ticket APP-2: Summary APP-2');
  });

  it('triages, routes, dispatches, and moves to review when the agent is done', async () => {
    const h = harness([
      def('Triage', 'triage'),
      def('Router', 'router'),
      def('Rui', 'backend'),
      def('Ana', 'frontend'),
    ]);
    h.inboxes = [jiraInbox('2026-01-01T00:00:00.000Z')];
    h.issues = [issue('APP-3')];
    await h.engine.refreshInbox('work');

    expect(h.store.get('APP-3')).toMatchObject({ state: 'triage', running: 'triage' });
    expect(h.headless[0].prompt).toBe('/triage APP-3');
    h.headless[0].resolve({ ok: true, output: 'Backend change in the auth API.' });
    await flush();

    expect(h.store.get('APP-3')).toMatchObject({ state: 'routing', running: 'routing' });
    expect(h.headless[1].prompt).toContain('Backend change in the auth API.');
    h.headless[1].resolve({ ok: true, output: '{"agent": "Rui", "reason": "Auth API"}' });
    await flush();

    expect(h.store.get('APP-3')).toMatchObject({
      state: 'working',
      assignee: 'Rui',
      dispatchNote: 'Auth API',
    });
    h.engine.onAgentStatus(1, 'active', false);
    h.engine.onAgentStatus(1, 'waiting', true);
    expect(h.store.get('APP-3')).toMatchObject({
      state: 'working',
      attention: expect.stringContaining('waiting'),
    });
    h.engine.onAgentStatus(1, 'active', false);
    h.engine.onAgentStatus(1, 'waiting', false);
    expect(h.store.get('APP-3')?.state).toBe('review');
    expect(h.store.get('APP-3')?.attention).toBeUndefined();
  });

  it('sends a no-fit ticket to the generalist, flagged', async () => {
    const h = harness([
      def('Router', 'router'),
      def('Rui', 'backend'),
      def('General', 'generalist'),
    ]);
    h.engine.createTask({ summary: 'Write the release notes' });
    h.headless[0].resolve({ ok: true, output: '{"agent": "none", "reason": "Docs work"}' });
    await flush();
    expect(h.store.get('task-1')).toMatchObject({
      state: 'working',
      assignee: 'General',
      flagged: true,
      dispatchNote: 'No specialist fits: Docs work',
    });
  });

  it('holds for a manual pick without a router, and dispatches the pick', () => {
    const h = harness([def('Rui', 'backend'), def('Ana', 'frontend')]);
    h.engine.createTask({ summary: 'Something' });
    expect(h.store.get('task-1')).toMatchObject({ state: 'routing', hold: true });
    h.engine.assignTask('task-1', 'ana');
    expect(h.store.get('task-1')).toMatchObject({ state: 'working', assignee: 'Ana' });
  });

  it('runs at most three at once and starts the next when one finishes', () => {
    const h = harness([def('Rui', 'backend')]);
    for (let i = 0; i < 4; i++) h.engine.createTask({ summary: `Task ${i}` });
    expect(h.launches).toHaveLength(3);
    expect(h.store.get('task-4')?.state).toBe('routing');

    h.engine.onAgentStatus(2, 'waiting', false);
    expect(h.store.get('task-2')?.state).toBe('review');
    expect(h.launches).toHaveLength(4);
    expect(h.store.get('task-4')?.state).toBe('working');
  });

  it('holds a task whose agent was closed before it finished', () => {
    const h = harness([def('Rui', 'backend')]);
    h.engine.createTask({ summary: 'Task' });
    h.engine.onAgentRemoved(1);
    expect(h.store.get('task-1')).toMatchObject({ state: 'routing', hold: true });
    expect(h.store.get('task-1')?.agentId).toBeUndefined();
    h.engine.startTask('task-1');
    expect(h.launches).toHaveLength(2);
  });

  it('holds with the reason when triage fails', async () => {
    const h = harness([def('Triage', 'triage'), def('Rui', 'backend')]);
    h.inboxes = [jiraInbox('2026-01-01T00:00:00.000Z')];
    h.issues = [issue('APP-9')];
    await h.engine.refreshInbox('work');
    h.headless[0].resolve({ ok: false, reason: 'Exited with 1: no login' });
    await flush();
    expect(h.store.get('APP-9')).toMatchObject({
      state: 'triage',
      hold: true,
      attention: 'Triage failed: Exited with 1: no login',
    });
    expect(h.store.get('APP-9')?.running).toBeUndefined();
  });
});
