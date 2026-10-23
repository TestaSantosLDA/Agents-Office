/**
 * Inboxes: where tasks come from besides typing them. v1 has one provider,
 * Jira, fetched on a click (refresh), never polled.
 *
 * Definitions and tokens live in `~/.pixel-agents/inboxes.json`, mode 0600.
 * Offices only ever see InboxSummary (`hasToken`, never the token), and the
 * mailbox furniture in a layout carries no credentials, so layouts stay
 * shareable.
 *
 * The fetch reads key and summary only. Agents read the full ticket through
 * the Jira MCP server on their own; nothing here writes to Jira.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { InboxInput, InboxSummary } from '../../../core/src/messages.js';
import { LAYOUT_FILE_DIR } from '../constants.js';
import { validateDirectoryPath } from '../directories.js';

export const INBOXES_FILE_NAME = 'inboxes.json';

/** Most issues one refresh imports (two pages of the Jira search). */
export const JIRA_MAX_ISSUES = 100;
const JIRA_PAGE_SIZE = 50;

export interface StoredInbox {
  id: string;
  name: string;
  provider: 'jira';
  baseUrl: string;
  email: string;
  apiToken: string;
  jql?: string;
  directoryPath?: string;
  lastRefreshAt?: string;
}

export interface FetchedIssue {
  key: string;
  summary: string;
  url: string;
}

export type InboxResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export function inboxesFilePath(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, INBOXES_FILE_NAME);
}

export function readInboxes(): StoredInbox[] {
  try {
    const raw = JSON.parse(fs.readFileSync(inboxesFilePath(), 'utf-8')) as { inboxes?: unknown };
    return Array.isArray(raw.inboxes) ? (raw.inboxes as StoredInbox[]) : [];
  } catch {
    return [];
  }
}

function writeInboxes(inboxes: StoredInbox[]): boolean {
  const file = inboxesFilePath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    // Created 0600: the file holds API tokens.
    fs.writeFileSync(tmp, JSON.stringify({ inboxes }, null, 2), { encoding: 'utf-8', mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    console.error(`[Pixel Agents] Could not write ${file}: ${String(err)}`);
    return false;
  }
}

export function summarizeInbox(inbox: StoredInbox): InboxSummary {
  const summary: InboxSummary = {
    id: inbox.id,
    name: inbox.name,
    provider: inbox.provider,
    baseUrl: inbox.baseUrl,
    email: inbox.email,
    hasToken: inbox.apiToken.length > 0,
  };
  if (inbox.jql) summary.jql = inbox.jql;
  if (inbox.directoryPath) summary.directoryPath = inbox.directoryPath;
  if (inbox.lastRefreshAt) summary.lastRefreshAt = inbox.lastRefreshAt;
  return summary;
}

export function listInboxSummaries(): InboxSummary[] {
  return readInboxes().map(summarizeInbox);
}

function trimmed(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

/** Create or replace an inbox. An empty token on an edit keeps the stored one. */
export function saveInbox(input: InboxInput): InboxResult<StoredInbox> {
  const name = trimmed(input.name);
  if (!name) return { ok: false, reason: 'Give the inbox a name.' };
  if (input.provider !== 'jira') return { ok: false, reason: 'Only Jira inboxes exist so far.' };

  let baseUrl = trimmed(input.baseUrl).replace(/\/+$/, '');
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:') return { ok: false, reason: 'The Jira URL must use https.' };
    baseUrl = url.origin;
  } catch {
    return { ok: false, reason: 'Enter the Jira URL, e.g. https://your-team.atlassian.net' };
  }
  const email = trimmed(input.email);
  if (!email) return { ok: false, reason: 'Enter the email of the Jira account.' };

  const inboxes = readInboxes();
  const id = trimmed(input.id);
  const existing = id ? inboxes.find((i) => i.id === id) : undefined;
  if (id && !existing) return { ok: false, reason: 'That inbox no longer exists.' };
  const apiToken = trimmed(input.apiToken) || existing?.apiToken || '';
  if (!apiToken) return { ok: false, reason: 'Enter a Jira API token.' };

  let directoryPath: string | undefined;
  if (trimmed(input.directoryPath)) {
    const checked = validateDirectoryPath(trimmed(input.directoryPath));
    if (!checked.ok) return { ok: false, reason: checked.reason };
    directoryPath = checked.path;
  }

  const inbox: StoredInbox = {
    id: existing?.id ?? `inbox-${crypto.randomUUID().slice(0, 8)}`,
    name,
    provider: 'jira',
    baseUrl,
    email,
    apiToken,
  };
  const jql = trimmed(input.jql);
  if (jql) inbox.jql = jql;
  if (directoryPath) inbox.directoryPath = directoryPath;
  // Same site, account and filter: keep the refresh mark. Anything else makes
  // the next refresh a first refresh again (its results come in held).
  if (
    existing?.lastRefreshAt &&
    existing.baseUrl === baseUrl &&
    existing.email === email &&
    existing.jql === inbox.jql
  ) {
    inbox.lastRefreshAt = existing.lastRefreshAt;
  }

  const next = existing ? inboxes.map((i) => (i.id === inbox.id ? inbox : i)) : [...inboxes, inbox];
  if (!writeInboxes(next)) return { ok: false, reason: 'Could not write the inbox settings.' };
  return { ok: true, value: inbox };
}

export function removeInbox(id: string): InboxResult<null> {
  const inboxes = readInboxes();
  if (!writeInboxes(inboxes.filter((i) => i.id !== id))) {
    return { ok: false, reason: 'Could not write the inbox settings.' };
  }
  return { ok: true, value: null };
}

export function markInboxRefreshed(id: string, at: Date): void {
  const inboxes = readInboxes();
  writeInboxes(inboxes.map((i) => (i.id === id ? { ...i, lastRefreshAt: at.toISOString() } : i)));
}

/** `assignee = currentUser()`, narrowed by the inbox's own filter. */
export function buildJql(filter: string | undefined): string {
  const base = 'assignee = currentUser()';
  const where = filter && filter.trim() ? `${base} AND (${filter.trim()})` : base;
  return `${where} ORDER BY updated DESC`;
}

type FetchFn = typeof fetch;

/**
 * Issues assigned to the token's user, newest first: key and summary only.
 * Uses the enhanced search endpoint (`/rest/api/3/search/jql`) with token
 * pagination.
 */
export async function fetchJiraIssues(
  inbox: StoredInbox,
  fetchFn: FetchFn = fetch,
): Promise<InboxResult<FetchedIssue[]>> {
  const auth = Buffer.from(`${inbox.email}:${inbox.apiToken}`).toString('base64');
  const issues: FetchedIssue[] = [];
  let nextPageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      jql: buildJql(inbox.jql),
      fields: 'summary',
      maxResults: String(JIRA_PAGE_SIZE),
    });
    if (nextPageToken) params.set('nextPageToken', nextPageToken);
    let response: Response;
    try {
      response = await fetchFn(`${inbox.baseUrl}/rest/api/3/search/jql?${params}`, {
        headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
      });
    } catch (err) {
      return { ok: false, reason: `Could not reach Jira: ${String(err)}` };
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: 'Jira refused the email and token.' };
    }
    if (!response.ok) {
      return { ok: false, reason: `Jira answered ${response.status}.` };
    }
    let body: { issues?: unknown[]; nextPageToken?: string; isLast?: boolean };
    try {
      body = (await response.json()) as typeof body;
    } catch {
      return { ok: false, reason: 'Jira sent something that is not JSON.' };
    }
    for (const raw of body.issues ?? []) {
      const issue = raw as { key?: unknown; fields?: { summary?: unknown } };
      if (typeof issue.key !== 'string') continue;
      issues.push({
        key: issue.key,
        summary: typeof issue.fields?.summary === 'string' ? issue.fields.summary : issue.key,
        url: `${inbox.baseUrl}/browse/${issue.key}`,
      });
    }
    nextPageToken = body.isLast === true ? undefined : body.nextPageToken;
  } while (nextPageToken && issues.length < JIRA_MAX_ISSUES);
  return { ok: true, value: issues.slice(0, JIRA_MAX_ISSUES) };
}
