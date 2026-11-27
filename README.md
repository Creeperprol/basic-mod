# basic-mod

- `ai-link` (AI Link, formerly `session-link`): a Claude Code mod (a plugin of function hooks) with two side panes.
- `link-bridge`: a small MCP server so Claude Code, Codex, Qwen Code and the Antigravity CLI (`agy`) sessions can message each other and hand out work (see `link-bridge/README.md`). It is the cross-CLI half of AI Link; the `ai-link` mod is the Claude Code half. One-shot helpers there let Claude use `agy` (`agy-worker.sh`) and Codex (`codex-agent.sh`, read-only by default) as agents; `link-grid.sh` and `big-grid.sh` open many workers in one tmux window, and messages are typed straight into their panes; `link_peers` also shows AI sessions in other panes of the same tmux window that have not joined; `lan.mjs` links sessions on other machines on the same Wi-Fi.

**Picker:** [`PICKER.md`](PICKER.md) shows how to open the session picker, read it, its keys, and how to script it.

**New to tmux?** [`TMUX.md`](TMUX.md) shows how to run your AI sessions in tmux so other sessions can type into them and the AI Remote phone app can show them live: install, keys, workspaces, phone setup, stopping sessions and troubleshooting.

## Install

Not on a marketplace. Clone the repo and load the plugin folder:

```
git clone https://github.com/Creeperprol/basic-mod
claude --plugin-dir basic-mod/ai-link
```

To load it in every session, add the folder's absolute path to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`.

## Usage pane

Shows the session name, model and reasoning effort, context fill (and where it compacts), the 5-hour and weekly limits with reset times, where the context goes by category, the tools being run, and turns, tool calls, cost and burn rate. Buttons: Refresh, Reset counts, Hide/Show tools, Hide/Show breakdown.

- `/usage-bar` opens the pane. The "Auto open" option (on by default) opens it at session start, and again on your first prompt so it also seats on terminals 110-143 columns wide. Below 110 columns it opens inline above the prompt or via the command.

## Session link

Lets your sessions on one machine find and message each other, and lets one act as the host.

- The `share` skill (`ai-link/skills/share`) teaches Claude, agy and Codex to open workers and share tasks; `link-bridge/install-skill.sh share` installs it into agy and Codex too.
- The `multi-window` skill is bundled (`ai-link/skills/multi-window`, loads as `ai-link:multi-window`). Loading it makes the session the host automatically, unless it holds a task (worker) or another host is running.
- `/sessions` lists the other running sessions. `/tell <name> <message>` and `/tellall <message>` send messages.
- `/host` makes this session the host. `/assign <name|auto|all> <task>` hands out a task (`auto` picks the least-loaded worker; the host's model is also told how to run workers: contract first, even sizing, verify reports); `/board` shows the open tasks (finished ones clear themselves), `/board clear` empties the board and messages. `/setname <name> <new name>` renames a worker. The pane has a box for typing a task.
- Workers answer through a `report` tool. While a worker holds a host task it is told to write no chat text and only report; a host's rename is applied by the plugin and never shown to the worker's model.
- `/run <name|all> /cost` and the `command` tool let the host run `compact`, `clear` or `cost` in a worker (commands that open a dialog, like `/model`, are refused). A result only clears a task when it comes from the worker it was assigned to, tasks open over 15 minutes show as stale, renames refuse a name another session already uses, and after a report the worker is told it is done so it writes no closing summary.
- "Auto-run tasks from the host" is off by default. When on, a task starts a turn in that session immediately, so only enable it for sessions you trust.
- A worker only accepts tasks and renames from the session registered as host. Sessions share a list through the plugin's own store file under `~/.claude`.

Tests: `claude plugin test ai-link`.

## Codex

Codex can't load Claude Code mods or draw side panes. Two things work there:

- `link-bridge` (above) gives Codex sessions the `link_*` tools to message other sessions and take tasks.
- Codex's own status line can show the same numbers as the usage pane. In `~/.codex/config.toml`:

```toml
[tui]
status_line = ["model-with-reasoning", "thread-name", "context-used", "five-hour-limit", "weekly-limit", "estimated-thread-cost", "task-progress"]
```

## Versions

- **ai-link 1.11.3** — picker sidebar buttons ([x], split, resize, zoom) act on the pane last clicked in tmux, and the highlight follows it; `link-bridge/tmux-drag-end.sh` with the `TMUX.md` bindings makes a mouse selection copy and clear wherever it is released, even over Claude Code and Codex panes.
- **ai-link 1.11.3** — picker sidebar buttons ([x], split, resize, zoom) act on the pane last clicked in tmux, and the highlight follows it; `link-bridge/tmux-drag-end.sh` with the `TMUX.md` bindings makes a mouse selection copy and clear wherever it is released, even over Claude Code and Codex panes.
- **ai-link 1.11.2** — `PICKER.md` guide; the picker no longer lists another picker's sidebar pane as a session, never labels a pane with Claude Code's version-number window name, and recognises unregistered agy panes (`agy-real`).
- **ai-link 1.11.1** — `TMUX.md`: how to use tmux with AI Link (install, keys, workspaces, phone remote, stopping sessions, troubleshooting).
- **ai-link 1.11.0** — `link-bridge/cloud-agent.mjs` sends tmux panes with their colours (`capture-pane -e`) for the AI Remote app's coloured terminal, trimmed on a line break so the relay never splits a colour code.
- **ai-link 1.10.0** — `link-bridge/cloud-agent.mjs` syncs this Mac's sessions to a Cloudflare Worker relay (the AI Remote app's `ai-remote/cloud` in the ai-link repo) so a phone can reach them from anywhere; link-bridge synced with ai-link (picker, tmux scripts); the picker selects the tmux window instead of swapping panes when the target is in another window of the same session.
- **ai-link 1.9.0** — `link-bridge/claude-worker.sh|ps1` lets agy and Codex open a visible Claude window as a worker; new `share` skill (`ai-link/skills/share`, installable into agy and Codex with `link-bridge/install-skill.sh share`).
- **ai-link 1.8.0** — no headless workers: `agy-worker` and `codex-agent` always open a window; `agy-image.sh` removed.
- **ai-link 1.7.1** — link-bridge: fixed the Windows SendKeys escape regex and agy trust path matching; Windows scripts checked under PowerShell 7.
- **ai-link 1.7.0** — link-bridge: Windows push delivery (win:<pid> window address, SendKeys) and `link-grid.ps1` (untested).
- **ai-link 1.6.0** — link-bridge: PowerShell versions of the agy and Codex helper scripts for Windows (untested).
- **ai-link 1.5.0** — the `multi-window` skill is bundled in the plugin; loading it as `ai-link:multi-window` (or plain `multi-window`) makes the session the host.
- **ai-link 1.4.1** — link-bridge: inside tmux, `link_peers` also lists AI sessions (claude, codex, agy, qwen, gemini) in other panes of the same window that have not joined link yet (1.4.0 added it, 1.4.1 documents it).
- **ai-link 1.3.3** — default session names are `claude-<id>` (like `codex-<id>`, `agy-<id>`); the folder and user name are no longer part of them. Saved names are kept.
- **ai-link 1.3.2** — link-bridge: a typed `[link MESSAGE ...]` now tells the receiver to answer with `link_tell` to the sender, so Codex workers stop replying only in their own chat.
- **ai-link 1.3.1** — link-bridge refuses a tool call with a missing required argument (a reply arrived as "undefined").
- **ai-link 1.3.0** — `link-bridge/listen.mjs`: `node listen.mjs install` adds a Claude Code hook so sessions read link messages by themselves where nothing can type into the window (Windows Terminal, VS Code, iTerm2).
- **ai-link 1.2.1** — `link-bridge/LAN-PROMPT.md`: a prompt to paste into Claude Code on the second computer; it installs and starts the Wi-Fi link there.
- **ai-link 1.2.0** — `link-bridge/lan.mjs` links sessions on two or more machines on the same Wi-Fi: run `node lan.mjs key` on one, `node lan.mjs join <key>` on the others, then `node lan.mjs` on each (see `link-bridge/README.md`).
- **ai-link 1.1.1** — taken off the `claude-mods` marketplace; install from a clone (see Install). If you installed it from the marketplace: `/plugin uninstall ai-link@claude-mods` and `/plugin marketplace remove claude-mods`.
- **ai-link 1.1.0** — renamed from `session-link` to `ai-link` (AI Link). If you installed the old name: `/plugin uninstall session-link@claude-mods`, then `/plugin install ai-link@claude-mods`.

- **session-link 0.2.1** — `/clear` no longer drops the session name or the host role: the new session picks them up from the one it replaced.
- **session-link 0.2.0** — usage and session link merged into one plugin; host mode (`/host`, `/assign`, `/board`, `/setname`, a prompt box); usage pane shows effort, session name and tools; opens on your first prompt so it seats from 110 columns; Windows paths handled.
- **session-link 0.1.0** — first release.
