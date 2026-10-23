# Agent Office, phase 2: Agent definitions and roles

An **Agent definition** is a named profile an agent can be launched with (see `CONTEXT.md`). Create one in the office, launch it from the drawer, and it starts as a Claude Code session with that role.

## In the office

`+ Agent` opens the launch drawer:

- **+ New agent** opens the create-agent screen: name, role, best at, tags, model, max at once, tools, skills, Directories and extra instructions.
- **Agents** lists the definitions. Clicking one launches it into its first Directory (or the start directory if it lists none). The pencil (long-press on touch) edits it.
- **Directories** works as before: a plain launch with no role.

A launch that breaks a rule is refused before anything spawns, with a notice at the top: a Directory the definition does not allow, or `max at once` already reached.

## On disk

One YAML file per definition in `~/.pixel-agents/agents/`, snake_case keys:

```yaml
name: Rita
role: bug-hunter
best_at: 'Reproducing and fixing backend bugs in Java/Spring services'
tags: [java, spring, backend, bugs]
skills: [spring-boot-debugging, triage]
tools: [Read, Edit, Bash, Grep]
model: sonnet
max_concurrent: 1
directories: [~/work/lokaly-api]
prompt: |
  Optional extra instructions, appended after the role.
```

Hand-written files work too. A file that does not parse is skipped with a warning in the server log.

## How a definition becomes a launch

| Field                               | Claude Code flag                                                              |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| role, best_at, tags, skills, prompt | `--append-system-prompt` ("You are Rita, an agent in Agent Office. Role: …")  |
| model                               | `--model`                                                                     |
| tools                               | `--tools Read,Edit,…` (restricts the built-in set; none = default set)        |
| skills from other Directories       | `--plugin-dir ~/.pixel-agents/agents/.plugins/<name>` with `skills/` symlinks |

The mapping lives in the Claude provider (`buildLaunchCommand`), behind the CLI-agnostic `LaunchProfile` in `core/src/provider.ts`.

**Skills.** Agents run on your own Claude login and `~/.claude`, so `~/.claude/skills` and the launch Directory's own `.claude/skills` are always loaded. Ticking one names it in the agent's system prompt: a focus, not a lock. Skills from other Directories are loaded for that agent only, through the generated plugin directory.

**The router is a role.** Phase 3's router is an ordinary definition (`role: router`) with your triage skill ticked. Phase 3 only adds the code that hands it a ticket and reads back its pick.

## Protocol

New messages in `core/asyncapi.yaml`: `agentDefinitionsLoaded`, `agentDefinitionSaved`, `agentDefinitionRejected`, `agentLaunchRejected` and `localSkillsLoaded` (server to client), and `saveAgentDefinition`, `removeAgentDefinition` and `requestLocalSkills` (client to server). `launchAgent` gains `definitionName`, `agentCreated` gains `definitionName`, and `existingAgents` gains `definitionNames`.

## Verified on 2026-10-23 (cloud container)

- 16 new server tests (`server/__tests__/agentDefinitions.test.ts`): validation, YAML round trip, save/rename/remove, local skills, Directory and concurrency rules, plugin dir, and the Claude flags.
- In the office (Playwright): created Rita (sonnet, Read+Edit, a user skill and a skill from another Directory, proj-a only) on the create-agent screen; the YAML landed in `~/.pixel-agents/agents/rita.yaml`; Rita showed in the drawer and launched as `claude --session-id … --model sonnet --tools Read,Edit --plugin-dir …/.plugins/rita --append-system-prompt "You are Rita…"`, seated in proj-a's Area; the plugin dir held only the foreign skill; a second launch with `max_concurrent: 1` was refused with a notice.

Still to check on a dev machine: a full Claude Code turn with a role (the container has no subscription login).
