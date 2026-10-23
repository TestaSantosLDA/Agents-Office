import { type KeyboardEvent, useEffect, useState } from 'react';

import type { InboxInput, InboxSummary } from '../../../core/src/messages.js';
import type { Directory } from '../hooks/useExtensionMessages.js';
import { Button } from './ui/Button.js';
import { Modal } from './ui/Modal.js';

interface InboxModalProps {
  isOpen: boolean;
  editing: InboxSummary | null;
  error: string | null;
  directories: Directory[];
  onSubmit: (inbox: InboxInput) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

const inputClass = 'text-sm py-2 px-4 bg-bg border-2 border-border rounded-none text-text';
const labelClass = 'flex flex-col gap-2 text-xs text-text-muted';

/**
 * A Jira inbox: the site, the account, its API token, and an optional JQL
 * filter on top of "assigned to me". The token is sent once and never comes
 * back; an edit with the field empty keeps the stored one.
 */
export function InboxModal({
  isOpen,
  editing,
  error,
  directories,
  onSubmit,
  onDelete,
  onClose,
}: InboxModalProps) {
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [email, setEmail] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [jql, setJql] = useState('');
  const [directoryPath, setDirectoryPath] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    setName(editing?.name ?? 'Jira');
    setBaseUrl(editing?.baseUrl ?? '');
    setEmail(editing?.email ?? '');
    setApiToken('');
    setJql(editing?.jql ?? '');
    setDirectoryPath(editing?.directoryPath ?? '');
  }, [isOpen, editing]);

  const submit = () => {
    onSubmit({
      ...(editing ? { id: editing.id } : {}),
      name,
      provider: 'jira',
      baseUrl,
      email,
      ...(apiToken ? { apiToken } : {}),
      jql,
      directoryPath,
    });
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    } else if (e.key === 'Enter' && e.target instanceof HTMLInputElement) {
      e.stopPropagation();
      e.preventDefault();
      submit();
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={editing ? 'Edit Jira inbox' : 'Add Jira inbox'}
      zIndex={54}
      className="min-w-[min(420px,100%)]!"
    >
      <div
        data-testid="inbox-modal"
        className="flex flex-col gap-8 px-10 py-4"
        onKeyDown={handleKeyDown}
      >
        <label className={labelClass}>
          Name
          <input
            type="text"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            className={inputClass}
          />
        </label>
        <label className={labelClass}>
          Jira URL
          <input
            type="text"
            value={baseUrl}
            placeholder="https://your-team.atlassian.net"
            onChange={(e) => setBaseUrl(e.target.value)}
            className={inputClass}
          />
        </label>
        <label className={labelClass}>
          Email
          <input
            type="text"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={inputClass}
          />
        </label>
        <label className={labelClass}>
          API token
          <input
            type="password"
            value={apiToken}
            autoComplete="off"
            placeholder={editing?.hasToken ? 'Saved; leave empty to keep it' : ''}
            onChange={(e) => setApiToken(e.target.value)}
            className={inputClass}
          />
        </label>
        <label className={labelClass}>
          Filter (JQL, optional, added to “assigned to me”)
          <input
            type="text"
            value={jql}
            placeholder='project = APP AND status != "Done"'
            onChange={(e) => setJql(e.target.value)}
            className={inputClass}
          />
        </label>
        <label className={labelClass}>
          Directory for its tickets
          <select
            value={directoryPath}
            onChange={(e) => setDirectoryPath(e.target.value)}
            className={inputClass}
          >
            <option value="">The agent’s own Directory</option>
            {directories.map((d) => (
              <option key={d.path} value={d.path}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <p className="text-xs text-text-muted m-0">
          Refresh reads the key and summary of tickets assigned to you. Nothing is written to Jira.
          The token is kept in ~/.pixel-agents/inboxes.json, readable only by you.
        </p>
        {error !== null && (
          <div role="alert" className="text-xs text-danger">
            {error}
          </div>
        )}
        <div className="flex items-center justify-between gap-8 pt-4">
          {editing ? (
            <Button
              variant="ghost"
              size="sm"
              className="text-danger!"
              onClick={() => onDelete(editing.id)}
            >
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
