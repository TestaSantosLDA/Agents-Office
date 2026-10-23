import { useCallback, useEffect, useRef, useState } from 'react';

import type { AgentDefinition } from '../../../core/src/messages.js';
import { transport } from '../transport/index.js';
import type { AgentDefinitionRejection, AgentDefinitionSaved } from './useExtensionMessages.js';

interface AgentDefinitionEditorInputs {
  agentDefinitions: AgentDefinition[];
  agentDefinitionSaved: AgentDefinitionSaved | null;
  agentDefinitionRejection: AgentDefinitionRejection | null;
}

/**
 * The create-agent modal's state and its round trips with the host, the same
 * shape as useDirectoryEditor: a save closes on its ack (agentDefinitionSaved),
 * a delete on the rebroadcast list, and agentDefinitionRejected keeps the modal
 * open with the reason. `pending` tells our own answer from another office's.
 */
export function useAgentDefinitionEditor({
  agentDefinitions,
  agentDefinitionSaved,
  agentDefinitionRejection,
}: AgentDefinitionEditorInputs) {
  const [modal, setModal] = useState<{ open: boolean; editing: AgentDefinition | null }>({
    open: false,
    editing: null,
  });
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<'save' | 'remove' | null>(null);

  const finish = useCallback(() => {
    pending.current = null;
    setModal({ open: false, editing: null });
    setError(null);
  }, []);

  useEffect(() => {
    if (agentDefinitionSaved === null || pending.current !== 'save') return;
    finish();
  }, [agentDefinitionSaved, finish]);

  useEffect(() => {
    if (pending.current !== 'remove') return;
    finish();
  }, [agentDefinitions, finish]);

  useEffect(() => {
    if (agentDefinitionRejection === null || pending.current === null) return;
    pending.current = null;
    setError(agentDefinitionRejection.reason);
  }, [agentDefinitionRejection]);

  const open = useCallback((editing: AgentDefinition | null) => {
    setError(null);
    setModal({ open: true, editing });
    // Asked per opening: skills come and go on disk.
    transport.send({ type: 'requestLocalSkills' });
  }, []);

  const add = useCallback(() => open(null), [open]);
  const edit = useCallback((definition: AgentDefinition) => open(definition), [open]);

  const close = useCallback(() => {
    pending.current = null;
    setModal({ open: false, editing: null });
    setError(null);
  }, []);

  const submit = useCallback(
    (definition: AgentDefinition) => {
      pending.current = 'save';
      setError(null);
      transport.send({
        type: 'saveAgentDefinition',
        definition,
        ...(modal.editing ? { previousName: modal.editing.name } : {}),
      });
    },
    [modal.editing],
  );

  const remove = useCallback(() => {
    if (!modal.editing) return;
    pending.current = 'remove';
    transport.send({ type: 'removeAgentDefinition', name: modal.editing.name });
  }, [modal.editing]);

  return { modal, error, add, edit, close, submit, remove };
}
