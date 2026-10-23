/**
 * Agent definitions: named, reusable profiles an agent can be launched with.
 *
 * One YAML file per definition in `~/.pixel-agents/agents/`, snake_case keys so
 * the files read naturally by hand:
 *
 *   name: Rita
 *   role: bug-hunter
 *   best_at: "Reproducing and fixing backend bugs in Java/Spring services"
 *   tags: [java, spring, backend, bugs]
 *   skills: [spring-boot-debugging]
 *   tools: [Read, Edit, Bash, Grep]
 *   model: sonnet
 *   max_concurrent: 1
 *   directories: [~/work/lokaly-api]
 *
 * The wire shape (AgentDefinition in the protocol) is the camelCase twin. This
 * module owns the conversion, the validation and the files; it knows nothing
 * about launching (see agentLaunch.ts).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse, stringify } from 'yaml';

import type { AgentDefinition } from '../../../core/src/messages.js';
import { LAYOUT_FILE_DIR } from '../constants.js';
import { expandTilde } from '../directories.js';

export const AGENT_DEFINITIONS_DIR_NAME = 'agents';

export type AgentDefinitionResult =
  { ok: true; definition: AgentDefinition } | { ok: false; reason: string };

/** `~/.pixel-agents/agents`, read at call time so tests can redirect $HOME. */
export function agentDefinitionsDir(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, AGENT_DEFINITIONS_DIR_NAME);
}

/** File stem for a definition name: lowercase, runs of anything else become `-`. */
export function slugifyAgentName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function stringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (trimmed.length > 0 && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

function optionalString(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Validate and normalize a definition from the office or from disk. Lists are
 * trimmed and deduped, Directory paths are tilde-expanded and resolved, empty
 * optional fields are dropped. The result is what gets stored and served.
 */
export function normalizeAgentDefinition(raw: unknown): AgentDefinitionResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, reason: 'Not an agent definition.' };
  }
  const input = raw as Record<string, unknown>;
  const name = optionalString(input.name);
  if (!name) return { ok: false, reason: 'Give the agent a name.' };
  if (slugifyAgentName(name).length === 0) {
    return { ok: false, reason: 'The name needs at least one letter or digit.' };
  }
  const role = optionalString(input.role);
  if (!role) return { ok: false, reason: 'Give the agent a role.' };

  let maxConcurrent: number | undefined;
  if (input.maxConcurrent !== undefined && input.maxConcurrent !== null) {
    const n = Number(input.maxConcurrent);
    if (!Number.isInteger(n) || n < 0) {
      return { ok: false, reason: 'Max concurrent must be a whole number, 0 for no limit.' };
    }
    if (n > 0) maxConcurrent = n;
  }

  const definition: AgentDefinition = { name, role };
  const bestAt = optionalString(input.bestAt);
  if (bestAt) definition.bestAt = bestAt;
  const tags = stringList(input.tags);
  if (tags.length > 0) definition.tags = tags;
  const skills = stringList(input.skills);
  if (skills.length > 0) definition.skills = skills;
  const tools = stringList(input.tools);
  if (tools.length > 0) definition.tools = tools;
  const model = optionalString(input.model);
  if (model) definition.model = model;
  if (maxConcurrent !== undefined) definition.maxConcurrent = maxConcurrent;
  const directories = stringList(input.directories).map((d) => path.resolve(expandTilde(d)));
  if (directories.length > 0) definition.directories = [...new Set(directories)];
  const prompt = optionalString(input.prompt);
  if (prompt) definition.prompt = prompt;
  return { ok: true, definition };
}

/** YAML (snake_case) → wire shape (camelCase), before validation. */
function fromYamlShape(doc: Record<string, unknown>): Record<string, unknown> {
  return {
    name: doc.name,
    role: doc.role,
    bestAt: doc.best_at,
    tags: doc.tags,
    skills: doc.skills,
    tools: doc.tools,
    model: doc.model,
    maxConcurrent: doc.max_concurrent,
    directories: doc.directories,
    prompt: doc.prompt,
  };
}

/** Wire shape → YAML document, keys in the order a person would write them. */
export function agentDefinitionToYaml(definition: AgentDefinition): string {
  const doc: Record<string, unknown> = { name: definition.name, role: definition.role };
  if (definition.bestAt) doc.best_at = definition.bestAt;
  if (definition.tags) doc.tags = definition.tags;
  if (definition.skills) doc.skills = definition.skills;
  if (definition.tools) doc.tools = definition.tools;
  if (definition.model) doc.model = definition.model;
  if (definition.maxConcurrent) doc.max_concurrent = definition.maxConcurrent;
  if (definition.directories) doc.directories = definition.directories;
  if (definition.prompt) doc.prompt = definition.prompt;
  return stringify(doc);
}

export function parseAgentDefinitionYaml(text: string): AgentDefinitionResult {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (err) {
    return { ok: false, reason: `Invalid YAML: ${String(err)}` };
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return { ok: false, reason: 'Expected a YAML mapping.' };
  }
  return normalizeAgentDefinition(fromYamlShape(doc as Record<string, unknown>));
}

interface AgentDefinitionEntry {
  definition: AgentDefinition;
  /** The file it was read from; hand-written files need not match the slug. */
  file: string;
}

/**
 * Every readable definition with its file. A file that fails to parse is
 * skipped with a warning rather than hiding the others; two files claiming the
 * same name keep the first in filename order.
 */
function listEntries(): AgentDefinitionEntry[] {
  const dir = agentDefinitionsDir();
  let files: string[];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
      .sort();
  } catch {
    return [];
  }
  const byName = new Map<string, AgentDefinitionEntry>();
  for (const file of files) {
    const full = path.join(dir, file);
    let text: string;
    try {
      text = fs.readFileSync(full, 'utf-8');
    } catch {
      continue;
    }
    const result = parseAgentDefinitionYaml(text);
    if (!result.ok) {
      console.warn(`[Pixel Agents] Agent definition ${file} skipped: ${result.reason}`);
      continue;
    }
    const key = result.definition.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, { definition: result.definition, file: full });
  }
  return [...byName.values()].sort((a, b) => a.definition.name.localeCompare(b.definition.name));
}

function findEntry(name: string): AgentDefinitionEntry | undefined {
  const key = name.trim().toLowerCase();
  return listEntries().find((e) => e.definition.name.toLowerCase() === key);
}

/** Every readable definition, sorted by name. */
export function listAgentDefinitions(): AgentDefinition[] {
  return listEntries().map((e) => e.definition);
}

export function findAgentDefinition(name: string): AgentDefinition | undefined {
  return findEntry(name)?.definition;
}

/** Write atomically (tmp + rename), like the layout and config files. */
function writeFileAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, 'utf-8');
  fs.renameSync(tmp, file);
}

/**
 * Create or replace a definition. `previousName` is the definition being edited:
 * its old file is replaced (a rename moves it to the new name's file). A name
 * already used by a different definition is refused, so a create never silently
 * overwrites.
 */
export function saveAgentDefinition(raw: unknown, previousName?: string): AgentDefinitionResult {
  const result = normalizeAgentDefinition(raw);
  if (!result.ok) return result;
  const { definition } = result;

  const clash = findEntry(definition.name);
  const previous = previousName !== undefined ? findEntry(previousName) : undefined;
  if (clash && clash.file !== previous?.file) {
    return { ok: false, reason: `An agent called ${clash.definition.name} already exists.` };
  }

  const file = path.join(agentDefinitionsDir(), `${slugifyAgentName(definition.name)}.yaml`);
  try {
    writeFileAtomic(file, agentDefinitionToYaml(definition));
    if (previous && previous.file !== file) fs.rmSync(previous.file, { force: true });
  } catch (err) {
    return { ok: false, reason: `Could not write ${file}: ${String(err)}` };
  }
  return { ok: true, definition };
}

/** Delete a definition. Agents already launched with it keep running. */
export function removeAgentDefinition(name: string): { ok: true } | { ok: false; reason: string } {
  const entry = findEntry(name);
  if (!entry) return { ok: true };
  try {
    fs.rmSync(entry.file, { force: true });
  } catch (err) {
    return { ok: false, reason: `Could not remove ${entry.definition.name}: ${String(err)}` };
  }
  return { ok: true };
}
