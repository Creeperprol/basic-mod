---
name: share
description: Share work between AI coding agents (Claude Code, Antigravity agy, Codex) through AI Link. Use when the user says share, hand off, give this to Claude, open Claude, open agy or codex, ask another agent, or wants several agents working on one job. Works from any of the three CLIs.
---

# share

Hand work to another agent running on this machine, over the link-bridge MCP server (`link_*` tools). Every worker runs in a **visible window**: never start a background or print-mode agent (no `agy -p`, no `codex exec` without its window, no `claude -p`).

## Prerequisite (once per CLI)

The `link` MCP server must be added to the CLI you are in (see `link-bridge/README.md`):

```
claude mcp add link --scope user -e LINK_CLI=claude -- node /path/to/link-bridge/server.mjs
codex mcp add link --env LINK_CLI=codex -- node /path/to/link-bridge/server.mjs
agy mcp add --env LINK_CLI=agy link "$(command -v node)" /path/to/link-bridge/server.mjs
```

## Open a worker (any CLI can do this from its shell tool)

Run from the `link-bridge/` folder (macOS `.sh`, Windows `.ps1`). Each opens one window and prints the worker's link name.

| Want | Command |
|---|---|
| Claude | `./claude-worker.sh -d DIR [-m haiku\|sonnet\|opus] [-N name] [-p "task"]` |
| Antigravity (agy) | `./agy-worker.sh -d DIR [-m gemini-3.8-flash-low] [-p "task"]` |
| Codex (one-shot, live window) | `./codex-agent.sh -d DIR [-s workspace-write] "task"` |
| Many at once (tmux) | `./link-grid.sh -n 4 -m mix` (Windows: `.\link-grid.ps1`) |

The folder must already be trusted by the CLI you open (Claude: `~/.claude.json`; agy: `trustedWorkspaces`). The scripts only read trust and refuse otherwise; the person decides what to trust.

Open exactly the number of workers the person asked for. If they gave no number, ask.

## Share a task

1. `link_peers` to see who is linked (use the names exactly as listed).
2. `link_host` once so you are the host, then `link_assign` with the worker name and a self-contained task: files it may edit, the contract to read, and a done-when check (a command that must pass).
3. The worker answers with `link_report`; the result arrives in your prompt as `[link RESULT ...]` (or read `link_board` / `link_inbox`).
4. Never trust a report alone: re-run the check yourself and say what you verified.

Light tasks (images, small chores) suit agy; reading and medium work suit Claude haiku or Codex; hard coding suits Claude opus or sonnet.

## Sharing a skill with another CLI

`./install-skill.sh share` copies this skill into the skill folders of Claude Code (`~/.claude/skills`), agy (`~/.gemini/antigravity-cli/skills`) and `~/.agents/skills`, so each agent finds it by name.
