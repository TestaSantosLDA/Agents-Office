import type { PointerEvent as ReactPointerEvent } from 'react';
import { useEffect, useRef } from 'react';

import { DRAWER_EDIT_LONG_PRESS_MAX_MOVE_PX, DRAWER_EDIT_LONG_PRESS_MS } from '../constants.js';
import type { Directory } from '../hooks/useExtensionMessages.js';
import type { AgentDefinitionLaunch } from './agentDefinitionLaunch.js';
import { Dropdown, DropdownItem } from './ui/Dropdown.js';

interface LaunchDrawerProps {
  isOpen: boolean;
  directories: Directory[];
  /** Launch into the tapped Directory. The surface owns the send, because what
   *  else a launch does differs per surface (mobile also slides to the new
   *  terminal). */
  onSelect: (directory: Directory) => void;
  /** Open the Directory modal empty (the pinned `+ Directory` row). */
  onAddDirectory: () => void;
  /** Open the Directory modal pre-filled with this entry (user-defined rows). */
  onEditDirectory: (directory: Directory) => void;
  /** Agent definitions (Agent Office). Absent: the drawer is Directories only. */
  agentDefinitionLaunch?: AgentDefinitionLaunch;
  className?: string;
}

/**
 * The launch button's drawer: one row per Directory an agent can be launched
 * into, with `+ Directory` pinned above them behind a separator. Opened by a
 * plain press of the launch button (and by hover on desktop), and rendered
 * above the button by the shared Dropdown. Every launch goes through a row
 * here — the button itself never launches.
 *
 * Rows arrive already ordered (host rows first, then user rows, each group
 * alphabetical) and already deduped: the union is built host-side, so every
 * office shows the same list in the same order.
 *
 * Only user-defined rows are editable — host-contributed rows (VS Code's
 * workspace folders, standalone's start directory) are the host's to define,
 * so they carry a badge and no edit affordance. The badge is aria-hidden so a
 * row's accessible name stays the bare Directory name. The pencil is part of
 * the row: revealed by hovering it where hover exists, and replaced by a
 * long-press on the row where it doesn't (both `hover:`-gated styling and the
 * `pointer-coarse:` hide follow the device, not the viewport).
 */
export function LaunchDrawer({
  isOpen,
  directories,
  onSelect,
  onAddDirectory,
  onEditDirectory,
  agentDefinitionLaunch,
  className = '',
}: LaunchDrawerProps) {
  const sectionLabel = 'px-8 pt-4 text-2xs text-text-muted select-none';
  return (
    // Open even with no Directories: `+ Directory` is always worth showing, and
    // an office with an empty list is exactly where it's needed most.
    // fitViewport: a long list must never push `+ Directory` above the top of
    // the screen, so the drawer is capped at the room above the button and
    // only the rows scroll.
    <Dropdown isOpen={isOpen} fitViewport className={`min-w-128 ${className}`}>
      <div data-testid="launch-drawer" className="flex flex-col min-h-0">
        {/* DropdownItem hard-resets to border-none, so the separator lives on
            this wrapper. Pinned: it never scrolls away with the rows. */}
        <div className="shrink-0 border-b-2 border-border">
          {agentDefinitionLaunch && (
            <DropdownItem
              onClick={agentDefinitionLaunch.onAdd}
              className="text-base text-accent-bright"
            >
              + New agent
            </DropdownItem>
          )}
          <DropdownItem onClick={onAddDirectory} className="text-base text-accent-bright">
            + Directory
          </DropdownItem>
        </div>
        <div className="min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain pixel-scrollbar">
          {agentDefinitionLaunch && agentDefinitionLaunch.definitions.length > 0 && (
            <>
              <div className={sectionLabel}>Agents</div>
              {agentDefinitionLaunch.definitions.map((definition) => (
                <DrawerRow
                  key={`agent:${definition.name}`}
                  testId="agent-definition-row"
                  label={definition.name}
                  title={[definition.role, definition.bestAt].filter(Boolean).join(' · ')}
                  badge={definition.role}
                  editable
                  editLabel={`Edit ${definition.name}`}
                  onSelect={() => agentDefinitionLaunch.onSelect(definition)}
                  onEdit={() => agentDefinitionLaunch.onEdit(definition)}
                />
              ))}
              <div className={sectionLabel}>Directories</div>
            </>
          )}
          {directories.map((directory) => (
            <DrawerRow
              key={directory.path}
              testId="directory-row"
              label={directory.name}
              title={directory.path}
              badge={directory.source === 'host' ? 'host' : undefined}
              editable={directory.source === 'user'}
              editLabel={`Edit ${directory.name}`}
              onSelect={() => onSelect(directory)}
              onEdit={() => onEditDirectory(directory)}
            />
          ))}
        </div>
      </div>
    </Dropdown>
  );
}

interface DrawerRowProps {
  testId: string;
  label: string;
  /** Hover text: a Directory's path, an agent's role and best-at. */
  title: string;
  /** Small aria-hidden tag after the label (`host`, an agent's role). */
  badge?: string;
  editable: boolean;
  editLabel: string;
  onSelect: () => void;
  onEdit: () => void;
}

/** One launch row: a Directory, or an Agent definition. */
function DrawerRow({
  testId,
  label,
  title,
  badge,
  editable,
  editLabel,
  onSelect,
  onEdit,
}: DrawerRowProps) {
  const longPressTimer = useRef<number | undefined>(undefined);
  const pressOrigin = useRef<{ x: number; y: number } | null>(null);
  /** Set when a long-press opened the edit modal, so the click the browser
   *  fires on finger-up doesn't ALSO launch an agent behind it. */
  const longPressFired = useRef(false);

  const cancelLongPress = () => {
    if (longPressTimer.current !== undefined) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = undefined;
    }
    pressOrigin.current = null;
  };

  useEffect(() => cancelLongPress, []);

  // The long-press is touch-only: a mouse has hover, so it gets the pencil.
  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!editable || e.pointerType !== 'touch') return;
    longPressFired.current = false;
    pressOrigin.current = { x: e.clientX, y: e.clientY };
    longPressTimer.current = window.setTimeout(() => {
      longPressTimer.current = undefined;
      longPressFired.current = true;
      onEdit();
    }, DRAWER_EDIT_LONG_PRESS_MS);
  };

  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (pressOrigin.current === null) return;
    const moved = Math.hypot(e.clientX - pressOrigin.current.x, e.clientY - pressOrigin.current.y);
    if (moved > DRAWER_EDIT_LONG_PRESS_MAX_MOVE_PX) cancelLongPress();
  };

  return (
    // The row is one hover surface: its own background covers the pencil strip
    // too, so the pencil reads as part of the item rather than a neighbor.
    // select-none + no touch callout keep a long-press from starting iOS text
    // selection; the context menu is Android's long-press, already spoken for.
    <div
      data-testid={testId}
      className="group flex items-center hover:bg-btn-bg select-none [-webkit-touch-callout:none]"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={cancelLongPress}
      onPointerCancel={cancelLongPress}
      onPointerLeave={cancelLongPress}
      onContextMenu={(e) => {
        if (editable) e.preventDefault();
      }}
    >
      <DropdownItem
        onClick={() => {
          if (longPressFired.current) {
            longPressFired.current = false;
            return;
          }
          onSelect();
        }}
        className="flex-1 min-w-0 text-base"
      >
        <span className="flex items-center justify-between gap-10">
          <span className="overflow-hidden text-ellipsis" title={title}>
            {label}
          </span>
          {badge !== undefined && (
            <span
              aria-hidden="true"
              className="shrink-0 text-2xs text-text-muted border-2 border-border pl-4 pr-2 leading-none"
            >
              {badge}
            </span>
          )}
        </span>
      </DropdownItem>
      {editable && (
        // Hidden until the row is hovered (hover: only exists on devices that
        // have it) or the button is keyboard-focused; gone entirely on coarse
        // pointers, where the row's long-press is the edit affordance.
        <button
          onClick={onEdit}
          aria-label={editLabel}
          title={editLabel}
          className="shrink-0 self-stretch flex items-center px-8 bg-transparent border-none rounded-none cursor-pointer text-sm leading-none text-text-muted hover:text-text opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:hidden"
        >
          <span className="material-symbols-sharp text-[12px]" aria-hidden="true">
            edit
          </span>
        </button>
      )}
    </div>
  );
}
