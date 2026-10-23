# Agent Office, phase 1: run upstream and set up Areas

Phase 1 changes no code. It proves the standalone adapter runs on our machines and that Areas give each project its own room.

## Run the standalone office

```sh
npm ci
npm run build
cd ~/work/<some-project>          # becomes the host-contributed Directory
node /path/to/agents-office/dist/cli.js --port 3999
```

Open the URL the CLI prints (it carries the server token). Without the token the office is read-only.

## One Area per project

1. **Directories.** `+ Agent` → add a Directory for each project folder. Name it after the folder.
2. **Areas.** `Layout` → Area tool → paint the tiles of each room and give the Area the same name as its Directory.
3. **Area mapping.** Map each Directory to its Area, from the Area's row in the layout editor or the Areas field of the Directory dialog. Many Directories may share one Area.
4. **Launch.** Launch an agent into each Directory. Its character takes a free seat inside that Directory's Area. Agents in unmapped Directories sit anywhere (the open space).

Area mappings live in `~/.pixel-agents/config.json`, the painted Areas in `~/.pixel-agents/layout.json`, and seats in `~/.pixel-agents/standalone-state.json`.

## Verified on 2026-10-23 (cloud container, v1.5.0)

- Build is clean on Node 22, and the office serves on `--port 3999`.
- Two Directories mapped to two Areas (left room, right room). One agent launched into each got a live `claude` PTY in the terminal drawer and a seat inside its own Area.
- `assets/furniture/MAILBOX/` loads unchanged: 12 sprites (front, back and mirrored side; `off` plus a 3-frame `on` animation).

Still to check on a dev machine: a full Claude Code turn. The cloud container had no subscription login, so `claude` stopped at its first-run screen.

## Decisions

- Areas need no code. A "create Area from Directory" shortcut waits until painting by hand proves annoying.
- Area and Directory names match the project folder names.
