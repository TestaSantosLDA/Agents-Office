# Agent Office, phase 3: queue, Jira inbox, router, dispatcher

Work now arrives as **Tasks** (see `CONTEXT.md`): Jira tickets from an **Inbox**, or tasks typed in the office. Each one is triaged, routed to an Agent definition, and dispatched as an ordinary agent, at most three at a time. When that agent finishes its turn the task waits in Review. Nothing leaves the machine.

## In the office

- **Tasks** (bottom toolbar, or the floating button on a phone) opens the queue. The button shows how many tasks you have not seen yet. Clicking any **mailbox** in the office opens the same panel, and every mailbox lights up while something is unseen. Opening the panel marks everything seen.
- **+ Jira inbox** asks for the site (`https://your-team.atlassian.net`), the account email, an API token, an optional JQL filter (added to `assignee = currentUser()`), and the Directory its tickets are worked in. **Refresh** next to an inbox fetches key and summary only.
- **Type a task** adds one by hand, optionally in a Directory.
- Each task shows its state, who it went to and why, anything that needs you (in orange), and its triage. **Start** releases a held task, **Assign to…** skips triage and routing, **Move to…** puts it in another state by hand, and **Open terminal** raises the working agent.

## The pipeline

| State   | What happens                                                                                                                                                                                                                                                                                                                                       |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| inbox   | New. The **first** refresh of an inbox brings tickets in held, so a backlog is not routed behind your back; Start the ones you want.                                                                                                                                                                                                               |
| triage  | Jira tickets only, and only if a definition has `role: triage`: a headless `claude -p "/triage <KEY>"` with that definition's profile. Its output travels with the task. No triage agent: skipped.                                                                                                                                                 |
| routing | The definition with `role: router` gets the agent index (name, role, best at, tags, busy or available), the ticket and the triage, and answers one line of JSON. No fit goes to the definition with `role: generalist`, flagged; without one, the task is held for you to assign. No router at all: the only worker gets it, otherwise you assign. |
| working | The pick is launched like a drawer launch (PTY, seat, terminal, its Directory rules and `max at once`), with the ticket as its first prompt. The prompt says to commit on a local branch and **not** to push, merge, open PRs, or comment on or transition the ticket.                                                                             |
| review  | The agent's turn ended (the same "done" signal as the office's status). Its session stays open. Phase 4 adds the review screen and the approval click.                                                                                                                                                                                             |
| done    | Moved there by hand for now.                                                                                                                                                                                                                                                                                                                       |

**Cap.** At most 3 at once, counting headless triage and router runs plus working tasks. The rest wait their turn, oldest first.

**Holds.** Anything that needs a person stops the task with a note instead of guessing: a failed triage or router run, a router with no usable answer, a Directory the agent does not allow, an agent closed mid-work, or a server restart (in-flight runs cannot be resumed). An agent asking a question in its terminal shows "waiting for your answer" but keeps its slot.

**Roles used by the pipeline.** `triage`, `router` and `reviewer` run steps and are never routed to. `generalist` is the no-fit fallback. Everything else is a worker.

## On disk

- `~/.pixel-agents/tasks.json`: the queue.
- `~/.pixel-agents/inboxes.json`: inboxes with their API tokens, mode 0600. Offices only ever receive `hasToken`, never the token; layouts stay shareable because a mailbox carries no settings.

## Protocol

Server to client: `tasksLoaded`, `taskUpdated`, `inboxesLoaded`, `inboxRefreshed`, `inboxRejected`. Client to server: `saveInbox`, `removeInbox`, `refreshInbox`, `createTask`, `startTask`, `assignTask`, `moveTask`, `markTasksSeen`. Task messages are never sent to a read-only office (no token), so ticket text stays with the operator.

`LaunchProfile` gains `initialPrompt`, and `HookProvider` gains `buildHeadlessCommand` (Claude: `claude -p <prompt>` plus the same profile flags).

## Verified on 2026-10-23 (cloud container)

- 21 new server tests (`server/__tests__/tasks.test.ts`): store persistence and restart holds, inbox validation and 0600 token file, Jira search pagination and auth errors, router prompt and answer parsing, the worker's "nothing leaves the machine" lines, headless and initial-prompt flags, and the engine (first-refresh holds, triage → routing → working → review, generalist fallback, manual pick, cap of 3, closed agent, failed triage).
- 2 new webview tests (`webview-ui/test/mailbox.test.ts`): the mailbox lights and goes dark, and its tiles are clickable.
- In the office (Playwright, a fake `claude` on PATH): typed a task; the Router definition ran headless (`claude -p … --model haiku --tools=Read --append-system-prompt "You are Router…"`) and picked Rita; Rita launched in a terminal with the task as her first prompt; a `Stop` hook for her session moved the task to Review. A plain-http Jira URL was refused in the inbox form.

Still to check on a dev machine: a real Jira refresh, and real triage and router turns with your triage skill (the container has no Jira account and no subscription login).
