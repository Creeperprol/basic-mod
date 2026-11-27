# Using the session picker

The picker (`link-bridge/picker.mjs`) is one screen that lists every AI session on this Mac, **Claude**, **Codex** and **agy** (plus other tmux windows), and jumps to the one you pick. It finds them in the link-bridge registry (`~/.ai-link/peers`), in tmux panes and in open Terminal windows, and can also resume past sessions. It needs Node 18+; tmux is optional but gives the most (see [`TMUX.md`](TMUX.md)).

## 1. Open it

| How | What you get |
|---|---|
| `link-bridge/picker.sh` | Full-screen picker in a new Terminal.app window |
| `link-bridge/picker.sh -w 310` | Narrow sidebar window (310 px) pinned to the left edge of the screen |
| `link-bridge/picker.sh --inline` | The picker in the terminal you are in |
| `link-bridge/picker.sh --tmux` | Opens, resumes and continues sessions in tmux windows (attaching if needed) |
| `link-bridge/link-workspace.sh -a` | tmux session `ai-link` with the picker pinned in the left pane and Claude, Codex and agy on the right |

Other options: `-d DIR` (folder for new or continued sessions), `--live-only` (hide past sessions), `--past-limit N` (past sessions per CLI).

## 2. Read the list

Sessions are grouped **CLAUDE**, **CODEX**, **AGY** and **TMUX** (tmux windows with no AI in them). Each row shows the name, the session's current **model** (e.g. `Opus 5.5`, `GPT-6-Luna high`, `Hydrogen High` for agy's *Gemini 4 Hydrogen (High)*; the folder when the model is unknown) and where it lives (`[ttys001]` for a Terminal tab, `[tmux:<session>:%3]` for a tmux pane).

| Mark | Meaning |
|---|---|
| `●` | Running |
| `◆` | The active pane of the active tmux window |
| `★` | The AI Link host |
| `↺` | A past session that can be resumed |

The list refreshes by itself; press `r` to refresh now.

## 3. Keys

| Key | Does |
|---|---|
| `↑` `↓` or `k` `j` | Move the selection (`PgUp` / `PgDn` jump) |
| `←` `→` or `h` `l`, `Tab` | Move between columns |
| `Enter`, `Space` or click | Switch to the selected session (raise its Terminal tab or tmux pane; resume it if it is a past session) |
| `1` to `9` | Switch to that row straight away |
| `t` | Open the selected session in tmux |
| `c` / `x` / `a` | Open a **new** Claude / Codex / agy session |
| `C` / `X` / `A` | **Continue** the latest Claude / Codex / agy session |
| `p` | Show or hide past sessions |
| `r` | Refresh |
| `q` or `Ctrl-C` | Quit the picker |

In a tmux workspace (`--tmux-sidebar`, from `link-workspace.sh`) these also work on the right-hand panes:

| Key | Does |
|---|---|
| `n` | New tmux window |
| `s` / `v` | Split side by side / top and bottom |
| `[` `]` (or `-` `+`) | Make the sidebar narrower / wider |
| `{` `}` | Resize up / down |
| `z` | Zoom the pane |
| `m` | Rename the tmux window (type the name, `Enter`; `Esc` cancels) |
| `K` | Kill the selected pane |

## 4. Without the screen (scripts)

```sh
link-bridge/picker.sh --list                 # print the groups and exit
link-bridge/picker.sh --json                 # the same as JSON
link-bridge/picker.sh --focus claude-4e40    # switch to (or resume) a session by name or id
link-bridge/picker.sh --continue codex       # continue the latest Codex session
link-bridge/picker.sh -n                     # dry run: print the command, open nothing
```

## 5. Troubleshooting

| Problem | Fix |
|---|---|
| A session is missing | It must have started with AI Link (Claude) or the `link` MCP server (Codex, agy), or be in a tmux pane or Terminal tab. iTerm2 windows are not seen. Press `r`. |
| A closed session is still listed | Its file is still in `~/.ai-link/peers/`; delete the files whose `pid` is no longer running. |
| Picking a session does nothing | Terminal.app needs Automation permission for the picker (System Settings → Privacy & Security → Automation). |
| `-w` is refused | The width must be 180 to 2000 px; or use full screen (no `-w`) or `--inline`. |
