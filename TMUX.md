# Using tmux with AI Link

AI Link works best when every AI session (Claude Code, Codex, agy) runs inside **tmux**. A session in a tmux pane can be typed into by other sessions (`link_tell`, `link_assign`), shown live in the picker, and viewed and driven from the **AI Remote** phone app. A session in a plain terminal tab only gets messages through its inbox and has no live view on the phone.

## 1. Install tmux

```sh
brew install tmux        # macOS
sudo apt install tmux    # Debian / Ubuntu
```

Windows has no tmux; use `link-bridge/link-grid.ps1`, which opens one PowerShell window per worker instead.

## 2. Start a session and run an AI in it

```sh
tmux new -s work         # new tmux session called "work"
claude                   # or: codex, agy
```

That is all AI Link needs: the session registers its tmux pane on start (`~/.ai-link/peers/<id>.json` has `"pane": "%0"`), so it shows up in `link_peers` and in the phone app.

`link_peers` also tells every AI which model each session is running, and its own: `claude-4e40  [claude, Opus 5.5]`, `agy-1  [agy, Gemini 4 Hydrogen (High)]`, `codex-1  [codex, GPT-6-Luna high]`. It is read from what each CLI records (Claude Code's transcript, agy's log, the Codex footer), so a `/model` switch shows up once that CLI has recorded it (for Claude, after its next reply).

Check from any other session:

```sh
tmux ls                                                  # tmux sessions
tmux list-panes -a -F '#{session_name} #{pane_id} #{pane_current_command}'
```

## 3. The keys you need

tmux keys start with the **prefix**, `Ctrl-b`, then one more key.

| Keys | What it does |
|---|---|
| `Ctrl-b d` | Detach: leave tmux, everything keeps running |
| `Ctrl-b %` | Split the pane left / right |
| `Ctrl-b "` | Split the pane top / bottom |
| `Ctrl-b ←↑→↓` | Move between panes |
| `Ctrl-b z` | Zoom the current pane full screen (again to unzoom) |
| `Ctrl-b c` | New window (tab) |
| `Ctrl-b n` / `Ctrl-b p` | Next / previous window |
| `Ctrl-b [` | Scroll mode (arrows / PgUp, `q` to leave) |
| `Ctrl-b x` | Close the current pane |

Mouse support (click panes, scroll with the wheel): add `set -g mouse on` to `~/.tmux.conf`, then `tmux source ~/.tmux.conf`.

## 4. Come back later

```sh
tmux attach -t work      # reattach to "work"
tmux attach              # reattach to the last session
```

Closing the terminal window does not stop the AI; it keeps running in tmux until you attach again.

## 5. Ready-made workspaces

All in `link-bridge/` (macOS / Linux, need tmux):

| Script | Opens |
|---|---|
| `./link-workspace.sh -a` | Session `ai-link`: session picker pinned left, Claude + Codex + agy on the right; picking a session swaps it into the main pane |
| `./tmux-open.sh -n 3 -m claude` | Full-screen workspace with N panes (`-m term`, `claude`, `codex`, `agy`, `mix`) and the picker |
| `./link-grid.sh -d <trusted folder> -n 8 -m mix -a` | Up to 8 tiled Codex / agy workers named `codex-1`, `agy-2`, ... |
| `./big-grid.sh` | 3 x 4 grid of Codex, Claude and agy plus one tall `claude-big` |
| `./picker.sh` | Just the session picker, in a narrow window on the left |

Grid workers run with their approval and sandbox bypass flags, so only point them at folders you trust.

## 6. See and drive tmux sessions from your phone

1. On the Mac, keep the cloud agent running: `node link-bridge/cloud-agent.mjs` (needs `~/.ai-link/cloud.json` with the relay `url` and `key`).
2. In **AI Remote**, set the server URL and key in Settings, tap the pairing link `ailink://pair?url=<relay url>&key=<key>`, or build the app with `ai-remote/AILinkRemote/Local.xcconfig` (the app lives in the [ai-link repo](https://github.com/Creeperprol/ai-link); see its `ai-remote/README.md`).
3. Tap a session to see its pane live, in colour, with Enter / y / arrow / Esc / Ctrl-C buttons and a text box.

Only sessions with a tmux pane have a live view; others say "No tmux pane for this session".

## 7. Stop sessions

```sh
tmux kill-session -t work          # one session and every AI in it
tmux kill-server                   # every tmux session
link-bridge/tmux-reap.sh sweep     # unattached @autokill sessions and children that ignore SIGHUP (agy)
```

## 8. Troubleshooting

| Problem | Fix |
|---|---|
| A session in tmux does not show on the phone | Check the cloud agent is running (`pgrep -fl cloud-agent`) and its log `~/.ai-link/cloud-agent.log` is not full of timeouts; restart it. Then check the app's server URL is the Cloudflare relay, not an old Supabase or `127.0.0.1` address. |
| Old, closed sessions still listed | Their process is gone but the file stayed in `~/.ai-link/peers/`. Delete the files whose `pid` is no longer running (`kill -0 <pid>` fails). |
| `link_peers` does not list a session | By default only tmux sessions are used; start it inside tmux, or pass `include_non_tmux: true`. |
| Messages arrive but are not typed in | The target is not in tmux or Terminal.app (iTerm2 is not supported); it reads them from `link_inbox` instead. |
| A mouse-drag highlight stays after you let go | Claude Code and Codex take the mouse and keep their own highlight, and tmux only clears a selection released inside the pane it started in. Add the block below to `~/.tmux.conf` and run `tmux source ~/.tmux.conf`. |
| `sessions should be nested with care` | You ran `tmux` inside tmux. Use `Ctrl-b c` for a new window instead, or `tmux switch -t <name>`. |

### Mouse selection like a normal terminal

Every drag becomes a tmux selection, even over Claude Code and Codex. Releasing it anywhere (the same pane, another pane, a border, the status line) copies it to the clipboard and clears the highlight, and a click clears one left behind. `link-bridge/tmux-drag-end.sh` does the copy and clear for the pane the drag started in; set `TMUX_COPY_CMD` for a clipboard other than `pbcopy` (e.g. `wl-copy`).

```tmux
set -g mouse on
DRAG_END="$HOME/path/to/ai-link/link-bridge/tmux-drag-end.sh"
bind-key -n MouseDrag1Pane set -gF @drag_pane '#{pane_id}' \; if-shell -F '#{pane_in_mode}' 'send-keys -M' 'copy-mode -M'
bind-key -T copy-mode    MouseDrag1Pane set -gF @drag_pane '#{pane_id}' \; select-pane \; send-keys -X begin-selection
bind-key -T copy-mode-vi MouseDrag1Pane set -gF @drag_pane '#{pane_id}' \; select-pane \; send-keys -X begin-selection
bind-key -T copy-mode    MouseDragEnd1Pane run-shell -b "$DRAG_END"
bind-key -T copy-mode-vi MouseDragEnd1Pane run-shell -b "$DRAG_END"
bind-key -n MouseDragEnd1Pane   run-shell -b "$DRAG_END"
bind-key -n MouseDragEnd1Border run-shell -b "$DRAG_END"
bind-key -n MouseDragEnd1Status run-shell -b "$DRAG_END"
bind-key -n MouseDown1Pane run-shell -b -t = "$DRAG_END '#{pane_id}'" \; select-pane -t = \; send-keys -M
bind-key -T copy-mode    MouseDown1Pane select-pane \; send-keys -X clear-selection
bind-key -T copy-mode-vi MouseDown1Pane select-pane \; send-keys -X clear-selection
```
