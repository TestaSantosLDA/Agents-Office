import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { InboxInput, InboxSummary, Task } from '../../../core/src/messages.js';
import { transport } from '../transport/index.js';

/** What the last refresh of an inbox brought in, for its row in the panel. */
export interface InboxRefreshNote {
  added: number;
  error?: string;
}

/**
 * The task queue as the host broadcasts it (tasksLoaded, then one taskUpdated
 * per change), the inboxes, and the inbox modal's round trips: a save closes
 * on the rebroadcast list, inboxRejected keeps the modal open with the reason.
 * Its own subscription, so the queue stays out of useExtensionMessages.
 */
export function useTasks() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [inboxes, setInboxes] = useState<InboxSummary[]>([]);
  const [refreshing, setRefreshing] = useState<Record<string, boolean>>({});
  const [refreshNotes, setRefreshNotes] = useState<Record<string, InboxRefreshNote>>({});
  const [inboxModal, setInboxModal] = useState<{ open: boolean; editing: InboxSummary | null }>({
    open: false,
    editing: null,
  });
  const [inboxError, setInboxError] = useState<string | null>(null);
  const pending = useRef(false);

  useEffect(
    () =>
      transport.onMessage((msg) => {
        if (msg.type === 'tasksLoaded') {
          setTasks((msg.tasks ?? []) as Task[]);
        } else if (msg.type === 'taskUpdated') {
          const task = msg.task as Task;
          setTasks((prev) => {
            const i = prev.findIndex((t) => t.id === task.id);
            if (i === -1) return [...prev, task];
            const next = prev.slice();
            next[i] = task;
            return next;
          });
        } else if (msg.type === 'inboxesLoaded') {
          setInboxes((msg.inboxes ?? []) as InboxSummary[]);
          if (pending.current) {
            pending.current = false;
            setInboxModal({ open: false, editing: null });
            setInboxError(null);
          }
        } else if (msg.type === 'inboxRejected') {
          if (pending.current) {
            pending.current = false;
            setInboxError(msg.reason as string);
          }
        } else if (msg.type === 'inboxRefreshed') {
          const inboxId = msg.inboxId as string;
          setRefreshing((prev) => ({ ...prev, [inboxId]: false }));
          setRefreshNotes((prev) => ({
            ...prev,
            [inboxId]: { added: msg.added as number, error: msg.error as string | undefined },
          }));
        }
      }),
    [],
  );

  const unseenCount = useMemo(() => tasks.filter((t) => t.seen === false).length, [tasks]);

  const refresh = useCallback((inboxId: string) => {
    setRefreshing((prev) => ({ ...prev, [inboxId]: true }));
    transport.send({ type: 'refreshInbox', inboxId });
  }, []);

  const openInbox = useCallback((editing: InboxSummary | null) => {
    pending.current = false;
    setInboxError(null);
    setInboxModal({ open: true, editing });
  }, []);

  const closeInbox = useCallback(() => {
    pending.current = false;
    setInboxError(null);
    setInboxModal({ open: false, editing: null });
  }, []);

  const saveInbox = useCallback((inbox: InboxInput) => {
    pending.current = true;
    setInboxError(null);
    transport.send({ type: 'saveInbox', inbox });
  }, []);

  const removeInbox = useCallback((id: string) => {
    pending.current = true;
    transport.send({ type: 'removeInbox', id });
  }, []);

  return {
    tasks,
    inboxes,
    unseenCount,
    refreshing,
    refreshNotes,
    refresh,
    inboxModal,
    inboxError,
    openInbox,
    closeInbox,
    saveInbox,
    removeInbox,
  };
}

export type TasksController = ReturnType<typeof useTasks>;
