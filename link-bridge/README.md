# AI Link bridge (link-bridge)

The cross-CLI half of AI Link: works with any MCP-capable CLI. The Claude Code half is the `ai-link` mod.

A tiny MCP server (no dependencies, Node 18+) that lets coding-agent sessions on one machine — Claude Code, Codex, Qwen Code, anything that speaks MCP — find and message each other, and lets one session host and hand out work.

State is plain files under `~/.session-link` (override with `LINK_HOME`). Nothing leaves the machine.

## Tools

| Tool | What it does |
|---|---|
| `link_peers` | List the other running sessions (name, CLI, folder) |
| `link_tell` / `link_tellall` | Message one session (name or id prefix) or all |
| `link_inbox` | Read and clear what was sent to you; `wait_seconds` waits for something |
| `link_host` | Become the host (or stop) |
| `link_assign` | Host: give a task to a worker or `all` |
| `link_report` | Worker: send a task's result back |
| `link_board` | Host: show tasks; `clear` drops finished ones |
| `link_rename` | Host: rename a worker as listed here |

A worker only obeys tasks and renames from the registered host. Sessions that stop (or stop answering for 60s) leave the list.

## Add it to each CLI

```
claude mcp add link --scope user -e LINK_CLI=claude -- node /path/to/server.mjs
codex mcp add link --env LINK_CLI=codex -- node /path/to/server.mjs
qwen mcp add link node /path/to/server.mjs -e LINK_CLI=qwen --trust
agy mcp add --env LINK_CLI=agy link /path/to/node /path/to/server.mjs
```

Codex asks before each MCP call; for hands-off use add `default_tools_approval_mode = "approve"` under `[mcp_servers.link]` in `~/.codex/config.toml`.

## How a task reaches a worker

**Push delivery (default).** Each server registers its terminal (the agent's tty, or its tmux pane). When someone sends a message, task or result, the server also types it into the target's prompt as one line tagged `[link MESSAGE ...]`, `[link TASK t1 ...]` or `[link RESULT t1 ...]`: with `tmux send-keys` for a tmux pane, or with Terminal.app `do script` for a Terminal tab (macOS). The text goes first and Enter follows 1 second later, because Codex treats a fast Enter as part of a paste. If typing worked, the inbox copy is removed; if it did not (no terminal, other terminal app), the message stays in the inbox and `link_inbox` still returns it. A worker can call `link_report` for a task it only saw typed.

- `LINK_WAKE=0` turns push delivery off (the tests do this); `LINK_WAKE_LOG=file` records what would be typed instead of typing it.
- Codex starts MCP servers from its shared app-server, so they have no terminal. Pass `LINK_PANE` (and `LINK_NAME`) through `-c mcp_servers.link.env...`; `link-grid.sh` does this. `LINK_TTY` sets the Terminal tab explicitly.
- Limits: Terminal.app and tmux only (not iTerm2); a message typed while the agent is busy is queued by that CLI; a CLI may ask permission before acting on it (agy did, for a harmless `ls`). Typing into a window is a form of remote prompt, so only sessions on your own machine can do it.
- Verified: real `claude -p` runs with hooks, `claude`/Codex/agy interactive windows in tmux and Terminal, and an end-to-end push through `server.mjs` into open Codex and agy windows.

**Fallback.** Without a terminal the old way applies: a worker is told to "wait for work with link_inbox (wait_seconds 100), do any task, then call link_report". Inside Claude Code the separate `ai-link` mod also does push delivery between Claude sessions.

## Up to 8 workers in one window (`link-grid.sh`)

`./link-grid.sh -d <trusted folder> -n 8 -m mix` opens one tmux session split into up to 8 tiled panes, alternating Codex (read-only) and agy (`-m codex` or `-m agy` for one kind). Workers appear in `link_peers` as `codex-1`, `agy-2`, ... with their pane, so `link_assign` types the task straight into the pane. `-a` attaches; `tmux kill-session -t link-grid` stops them all. Needs `tmux`. Verified with 8 panes: all 8 registered, and a message typed into `codex-1` and `agy-2` arrived (Codex answered; agy asked for permission before replying).

## Test

`node --test test.mjs` runs a fake Claude, Codex and Qwen session through find, message, host, assign, report, board, rename and leave, plus push delivery (in log mode, so nothing is typed into your terminals) and the argument checks of the helper scripts.

## Antigravity CLI (`agy`, tested on 1.4.4)

`agy` joins the same way as the others (`agy mcp add` above; `agy mcp list` should show `link` enabled). A Claude Code, Codex or Qwen host then sees it in `link_peers` as `agy-<folder>-<id>  [agy]`, hands it work with `link_assign`, and reads the result with `link_inbox` (verified end to end: Claude host -> agy worker -> `RESULT ... 391`, two tasks in a row to one worker).

Start a worker with the launcher (it builds the prompt that makes agy wait on `link_inbox`, do each task and answer with `link_report`):

```
./agy-worker.sh -d /some/trusted/folder -m gemini-3.8-flash-low       # headless background worker
./agy-worker.sh -d /some/trusted/folder -m claude-sonnet-4-6 -w        # interactive Terminal window
./agy-worker.sh -n ...                                                  # dry run: print the command
```

Things that bite:
- **Permissions.** Headless (`-p`) agy cannot prompt, so any tool it has no rule for is auto-denied and the session ends with "a tool required the ... permission". Allow only what a worker needs in `~/.gemini/antigravity-cli/settings.json`, one rule per tool, no wildcards: `"permissions": {"allow": ["mcp(link/link_inbox)", "mcp(link/link_report)", "mcp(link/link_peers)", "mcp(link/link_tell)"]}`. A task that needs a shell needs a `command(<prefix>)` rule you have checked, or run the worker interactively (`-w`) and approve at the keyboard. `--dangerously-skip-permissions` auto-approves everything; avoid it.
- **Trust question.** Like Claude Code, an interactive agy window in a folder it does not trust yet stops at "Do you trust the contents of this project?" (Yes, I trust this folder / No, exit) and a worker there never starts. Headless (`-p`) runs do not ask. Trusted folders are listed under `trustedWorkspaces` in the same settings file (`/tmp` is on this machine). `agy-worker.sh -w` checks that list first (read-only) and refuses with the reason; it never trusts a folder for you, that answer is yours to give.
- **Models.** `agy models` lists them (here: `gemini-3.8-flash-low|medium|high`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, `gpt-oss-120b-medium`). `--mode auto` is not available on this account.
- **Pull, not push.** Like Codex and Qwen, an agy session only sees a task when it calls `link_inbox`, which is why the launcher's prompt loops on it. After two empty waits (about 200 s) the worker stops; start another or give it work sooner.

### Make an image with agy, agent-style
`./agy-image.sh [-o out.jpg] [-m model] [-t seconds] "what the image shows"` starts a headless agy, asks it to use its `generate_image` tool once, waits for the file path, copies the image to `-o` (default `~/Projects/agy-images/`), prints the final path and lets agy exit. No window, no MCP, no permission rule needed for this tool in headless mode. Verified twice (a navy NFC tag, a hand tapping a phone to a pink tag; about 30-40 s each). It fails clearly when agy returns no image, for example `429 RESOURCE_EXHAUSTED` when the account's image quota is used up (hit on the third request in a row).

## Codex as a one-shot agent (`codex-agent.sh`, tested on codex-cli 0.162.1)

`./codex-agent.sh [-d dir] [-m model] [-s read-only|workspace-write] [-t seconds] [-o file] [-i image]... "the task"` runs `codex exec` for one task, prints its final message and lets it exit, the way a subagent would. Nothing stays running.

Pass `-i image.png` (repeatable) to let the headless agent see an image, e.g. a screenshot. Verified: a solid red PNG was described as "Red".

Pass `-w` to open a Terminal window that shows the agent working live (its commands and reply stream in, then `[codex finished]`). Verified: the window showed the `ls` command and the answer.

- **Safe by default:** read-only sandbox, no approval bypass, session not kept on disk (`--ephemeral`). `workspace-write` is opt-in with `-s`; `danger-full-access` and the bypass flags are deliberately not offered.
- **Verified:** "17 times 23" returned `391` in 12 s; a request to create a file under read-only was refused by the sandbox and reported honestly (8 s, no file); under `workspace-write` the file was created (34 s).
- **Persistent worker instead?** A Codex session that already has the `link` MCP server (see "Add it to each CLI") can be driven with `link_assign` / `link_inbox` like the other CLIs; use `codex-agent.sh` for fire-and-forget tasks.

## Big grid: 12 workers plus one big Claude (`big-grid.sh`)

`./big-grid.sh` opens one tmux window (session `link-grid`, needs `tmux`): the left 75% is a 3 x 4 grid (row 1 Codex `codex-1`..`codex-4`; row 2 Claude `claude-1`..`claude-4`; row 3 agy `agy-1`..`agy-4`) and the right 25% is one tall Claude, `claude-big`. Every pane registers with its tmux pane, so `link_tell` / `link_assign` type straight into it (a Codex or agy window opened as a plain Terminal tab has no pane and cannot be typed into). Attach with `tmux attach -t link-grid`; stop all 13 with `tmux kill-session -t link-grid`. Folder is `$HOME` and the Claude model is `sonnet`; edit `DIR` / `MODEL` at the top. Each session uses memory, so on an 8 GB Mac watch Memory Pressure. Codex and agy panes run with their approval and sandbox bypass flags, so only point `DIR` at a folder you trust.
