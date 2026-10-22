# claude-mods

- `session-link`: a Claude Code mod (a plugin of function hooks) with two side panes.
- `link-bridge`: a small MCP server so Claude Code, Codex, Qwen Code and the Antigravity CLI (`agy`) sessions can message each other and hand out work (see `link-bridge/README.md`). It is the cross-CLI half of Agent Link; the `session-link` mod is the Claude Code half. One-shot helpers there let Claude use `agy` (`agy-worker.sh`, `agy-image.sh`) and Codex (`codex-agent.sh`, read-only by default) as agents.

## Install

```
/plugin marketplace add Creeperprol/basic-mod
/plugin install session-link@claude-mods
```

## Usage pane

Shows the session name, model and reasoning effort, context fill (and where it compacts), the 5-hour and weekly limits with reset times, where the context goes by category, the tools being run, and turns, tool calls, cost and burn rate. Buttons: Refresh, Reset counts, Hide/Show tools, Hide/Show breakdown.

- `/usage-bar` opens the pane. The "Auto open" option (on by default) opens it at session start, and again on your first prompt so it also seats on terminals 110-143 columns wide. Below 110 columns it opens inline above the prompt or via the command.

## Session link

Lets your sessions on one machine find and message each other, and lets one act as the host.

- `/sessions` lists the other running sessions. `/tell <name> <message>` and `/tellall <message>` send messages.
- `/host` makes this session the host. `/assign <name|auto|all> <task>` hands out a task (`auto` picks the least-loaded worker; the host's model is also told how to run workers: contract first, even sizing, verify reports); `/board` shows the open tasks (finished ones clear themselves), `/board clear` empties the board and messages. `/setname <name> <new name>` renames a worker. The pane has a box for typing a task.
- Workers answer through a `report` tool. While a worker holds a host task it is told to write no chat text and only report; a host's rename is applied by the plugin and never shown to the worker's model.
- `/run <name|all> /cost` and the `command` tool let the host run `compact`, `clear` or `cost` in a worker (commands that open a dialog, like `/model`, are refused). A result only clears a task when it comes from the worker it was assigned to, tasks open over 15 minutes show as stale, renames refuse a name another session already uses, and after a report the worker is told it is done so it writes no closing summary.
- "Auto-run tasks from the host" is off by default. When on, a task starts a turn in that session immediately, so only enable it for sessions you trust.
- A worker only accepts tasks and renames from the session registered as host. Sessions share a list through the plugin's own store file under `~/.claude`.

Tests: `claude plugin test session-link`.

## Codex

Codex can't load Claude Code mods or draw side panes. Two things work there:

- `link-bridge` (above) gives Codex sessions the `link_*` tools to message other sessions and take tasks.
- Codex's own status line can show the same numbers as the usage pane. In `~/.codex/config.toml`:

```toml
[tui]
status_line = ["model-with-reasoning", "thread-name", "context-used", "five-hour-limit", "weekly-limit", "estimated-thread-cost", "task-progress"]
```

## Versions

- **session-link 0.2.1** — `/clear` no longer drops the session name or the host role: the new session picks them up from the one it replaced.
- **session-link 0.2.0** — usage and session link merged into one plugin; host mode (`/host`, `/assign`, `/board`, `/setname`, a prompt box); usage pane shows effort, session name and tools; opens on your first prompt so it seats from 110 columns; Windows paths handled.
- **session-link 0.1.0** — first release.
