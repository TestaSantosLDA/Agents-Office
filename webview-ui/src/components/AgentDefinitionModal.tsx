import type { KeyboardEvent } from 'react';
import { useEffect, useState } from 'react';

import type { AgentDefinition, LocalSkill } from '../../../core/src/messages.js';
import type { Directory } from '../hooks/useExtensionMessages.js';
import { AGENT_MODEL_CHOICES, AGENT_TOOL_CHOICES } from './agentDefinitionLaunch.js';
import { Button } from './ui/Button.js';
import { Modal } from './ui/Modal.js';

interface AgentDefinitionModalProps {
  isOpen: boolean;
  /** The definition being edited, or null when creating one. */
  editing: AgentDefinition | null;
  /** Why the last save was refused, shown inline. */
  error: string | null;
  directories: Directory[];
  skills: LocalSkill[];
  onSubmit: (definition: AgentDefinition) => void;
  onDelete: () => void;
  onClose: () => void;
}

function splitTags(raw: string): string[] {
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

/**
 * The create-agent screen: who the agent is (name, role, best at, tags), how
 * it runs (model, tools, skills) and where it may work (Directories).
 *
 * Like the Directory modal it never guesses: the host validates and stores the
 * definition, and the surface closes the modal on the host's ack.
 */
export function AgentDefinitionModal({
  isOpen,
  editing,
  error,
  directories,
  skills,
  onSubmit,
  onDelete,
  onClose,
}: AgentDefinitionModalProps) {
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [bestAt, setBestAt] = useState('');
  const [tags, setTags] = useState('');
  const [model, setModel] = useState('');
  const [tools, setTools] = useState<string[]>([]);
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [selectedDirectories, setSelectedDirectories] = useState<string[]>([]);
  const [maxConcurrent, setMaxConcurrent] = useState('');
  const [prompt, setPrompt] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    setName(editing?.name ?? '');
    setRole(editing?.role ?? '');
    setBestAt(editing?.bestAt ?? '');
    setTags((editing?.tags ?? []).join(', '));
    setModel(editing?.model ?? '');
    setTools(editing?.tools ?? []);
    setSelectedSkills(editing?.skills ?? []);
    setSelectedDirectories(editing?.directories ?? []);
    setMaxConcurrent(editing?.maxConcurrent ? String(editing.maxConcurrent) : '');
    setPrompt(editing?.prompt ?? '');
  }, [isOpen, editing]);

  if (!isOpen) return null;

  const submit = () => {
    const definition: AgentDefinition = { name: name.trim(), role: role.trim() };
    if (bestAt.trim()) definition.bestAt = bestAt.trim();
    const tagList = splitTags(tags);
    if (tagList.length > 0) definition.tags = tagList;
    if (model) definition.model = model;
    if (tools.length > 0) definition.tools = tools;
    if (selectedSkills.length > 0) definition.skills = selectedSkills;
    if (selectedDirectories.length > 0) definition.directories = selectedDirectories;
    // Left to the host to validate: a typo is refused there with a reason.
    if (maxConcurrent.trim()) definition.maxConcurrent = Number(maxConcurrent.trim());
    if (prompt.trim()) definition.prompt = prompt.trim();
    onSubmit(definition);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    } else if (e.key === 'Enter') {
      e.stopPropagation();
      // Enter saves from single-line fields only; in the prompt it is a newline.
      if (e.target instanceof HTMLInputElement) {
        e.preventDefault();
        submit();
      }
    }
  };

  // A skill attached earlier but no longer on disk stays visible (and
  // removable) rather than silently vanishing from the definition.
  const skillNames = new Set(skills.map((s) => s.name));
  const missingSkills = selectedSkills.filter((s) => !skillNames.has(s));
  // Same for a Directory the definition names that the office no longer lists.
  const directoryPaths = new Set(directories.map((d) => d.path));
  const extraDirectories = selectedDirectories.filter((p) => !directoryPaths.has(p));

  const inputClass = 'text-sm py-2 px-4 bg-bg border-2 border-border rounded-none text-text';
  const chip = (selected: boolean) =>
    `text-sm py-2 px-4 border-2 rounded-none cursor-pointer ${
      selected
        ? 'bg-accent border-accent text-text'
        : 'bg-transparent border-border text-text-muted hover:text-text'
    }`;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={editing ? `Edit ${editing.name}` : 'New agent'}
      className="min-w-[min(480px,100%)]!"
    >
      <div
        data-testid="agent-definition-modal"
        className="flex flex-col gap-8 px-10 py-4 max-h-[70vh] overflow-y-auto pixel-scrollbar"
        onKeyDown={handleKeyDown}
      >
        <div className="flex gap-8">
          <label className="flex flex-col gap-2 text-xs text-text-muted flex-1">
            Name
            <input
              type="text"
              value={name}
              autoFocus
              placeholder="Rita"
              onChange={(e) => setName(e.target.value)}
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-2 text-xs text-text-muted flex-1">
            Role
            <input
              type="text"
              value={role}
              placeholder="bug-hunter"
              onChange={(e) => setRole(e.target.value)}
              className={inputClass}
            />
          </label>
        </div>
        <label className="flex flex-col gap-2 text-xs text-text-muted">
          Best at
          <input
            type="text"
            value={bestAt}
            placeholder="Reproducing and fixing backend bugs in Java/Spring services"
            onChange={(e) => setBestAt(e.target.value)}
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-2 text-xs text-text-muted">
          Tags
          <input
            type="text"
            value={tags}
            placeholder="java, spring, backend"
            onChange={(e) => setTags(e.target.value)}
            className={inputClass}
          />
        </label>
        <div className="flex gap-8">
          <label className="flex flex-col gap-2 text-xs text-text-muted flex-1">
            Model
            <select value={model} onChange={(e) => setModel(e.target.value)} className={inputClass}>
              {/* A model typed into the YAML by hand stays selectable. */}
              {[
                ...AGENT_MODEL_CHOICES,
                ...(AGENT_MODEL_CHOICES.includes(model as never) ? [] : [model]),
              ].map((m) => (
                <option key={m} value={m}>
                  {m === '' ? 'Default' : m}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-2 text-xs text-text-muted flex-1">
            Max at once
            <input
              type="text"
              inputMode="numeric"
              value={maxConcurrent}
              placeholder="No limit"
              onChange={(e) => setMaxConcurrent(e.target.value)}
              className={inputClass}
            />
          </label>
        </div>
        <div data-testid="agent-definition-tools" className="flex flex-col gap-2">
          <span className="text-xs text-text-muted">
            Tools {tools.length === 0 && <span>(none ticked: the default set)</span>}
          </span>
          <div className="flex flex-wrap gap-4">
            {[
              ...AGENT_TOOL_CHOICES,
              ...tools.filter((t) => !AGENT_TOOL_CHOICES.includes(t as never)),
            ].map((tool) => (
              <button
                key={tool}
                onClick={() => setTools((prev) => toggle(prev, tool))}
                aria-pressed={tools.includes(tool)}
                className={chip(tools.includes(tool))}
              >
                {tool}
              </button>
            ))}
          </div>
        </div>
        <div data-testid="agent-definition-skills" className="flex flex-col gap-2">
          <span className="text-xs text-text-muted">Skills</span>
          {skills.length === 0 && missingSkills.length === 0 ? (
            <span className="text-xs text-text-muted">
              No local skills found in ~/.claude/skills or your Directories.
            </span>
          ) : (
            <div className="flex flex-wrap gap-4">
              {skills.map((skill) => (
                <button
                  key={skill.name}
                  onClick={() => setSelectedSkills((prev) => toggle(prev, skill.name))}
                  aria-pressed={selectedSkills.includes(skill.name)}
                  title={[
                    skill.description,
                    skill.source === 'user' ? '~/.claude/skills' : skill.directoryName,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                  className={chip(selectedSkills.includes(skill.name))}
                >
                  {skill.name}
                </button>
              ))}
              {missingSkills.map((name) => (
                <button
                  key={name}
                  onClick={() => setSelectedSkills((prev) => toggle(prev, name))}
                  aria-pressed
                  title="Not found on this machine; tap to detach"
                  className={`${chip(true)} line-through`}
                >
                  {name}
                </button>
              ))}
            </div>
          )}
        </div>
        <div data-testid="agent-definition-directories" className="flex flex-col gap-2">
          <span className="text-xs text-text-muted">
            Directories{' '}
            {selectedDirectories.length === 0 && <span>(none ticked: any Directory)</span>}
          </span>
          <div className="flex flex-wrap gap-4">
            {directories.map((directory) => (
              <button
                key={directory.path}
                onClick={() => setSelectedDirectories((prev) => toggle(prev, directory.path))}
                aria-pressed={selectedDirectories.includes(directory.path)}
                title={directory.path}
                className={chip(selectedDirectories.includes(directory.path))}
              >
                {directory.name}
              </button>
            ))}
            {extraDirectories.map((p) => (
              <button
                key={p}
                onClick={() => setSelectedDirectories((prev) => toggle(prev, p))}
                aria-pressed
                title={p}
                className={chip(true)}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
        <label className="flex flex-col gap-2 text-xs text-text-muted">
          Extra instructions
          <textarea
            value={prompt}
            rows={3}
            placeholder="Appended to the system prompt after the role."
            onChange={(e) => setPrompt(e.target.value)}
            className={`${inputClass} resize-y`}
          />
        </label>
        {error !== null && (
          <div role="alert" className="text-xs text-danger">
            {error}
          </div>
        )}
        <div className="flex items-center justify-between gap-8 pt-4">
          {/* Deleting a definition leaves agents launched with it running. */}
          {editing ? (
            <Button variant="ghost" size="sm" className="text-danger!" onClick={onDelete}>
              Delete
            </Button>
          ) : (
            <span />
          )}
          <span className="flex items-center gap-8">
            <Button variant="default" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="accent" size="sm" onClick={submit}>
              Save
            </Button>
          </span>
        </div>
      </div>
    </Modal>
  );
}
