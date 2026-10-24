#!/bin/bash
# Open ONE tmux window split into up to 8 panes, each running a Codex or agy worker. Each worker registers with the
# link bridge together with its tmux pane, so the host pushes tasks straight into the pane (see "Push delivery").
#
#   link-grid.sh [-d DIR] [-s SESSION] [-n COUNT] [-m MIX] [-a]
#     -d DIR      folder every worker starts in (default: current folder; must be one the CLIs trust)
#     -s SESSION  tmux session name (default: link-grid)
#     -n COUNT    number of panes, 1-8 (default 4)
#     -m MIX      which CLI per pane: "claude", "codex", "agy" or "mix" = alternate codex, agy, ... (default mix)
#     -M MODEL    model for claude panes (default sonnet; e.g. haiku, opus)
#     -a          attach to the session when done (default: just print how to)
# Workers are named <cli>-<n> (claude-1, codex-2, agy-3, ...). Codex runs read-only with no approval bypass; agy asks for permission as usual.
set -euo pipefail
DIR="$PWD"; SESSION="link-grid"; COUNT=4; MIX="mix"; MODEL="sonnet"; ATTACH=0
while getopts "d:s:n:m:M:a" o; do
  case "$o" in
    d) DIR="$OPTARG" ;; s) SESSION="$OPTARG" ;; n) COUNT="$OPTARG" ;; m) MIX="$OPTARG" ;; M) MODEL="$OPTARG" ;; a) ATTACH=1 ;;
    *) sed -n '2,15p' "$0"; exit 2 ;;
  esac
done
case "$COUNT" in [1-8]) ;; *) echo "-n must be 1 to 8" >&2; exit 2 ;; esac
case "$MIX" in claude|codex|agy|mix) ;; *) echo "-m must be claude, codex, agy or mix" >&2; exit 2 ;; esac
case "$MODEL" in *[!A-Za-z0-9._:-]*|"") echo "invalid model name" >&2; exit 2 ;; esac
case "$SESSION" in *[!A-Za-z0-9_-]*|"") echo "invalid session name" >&2; exit 2 ;; esac
[ -d "$DIR" ] || { echo "no such folder: $DIR" >&2; exit 2; }
command -v tmux >/dev/null || { echo "tmux is required (brew install tmux)" >&2; exit 2; }
tmux has-session -t "$SESSION" 2>/dev/null && { echo "session $SESSION already exists (tmux attach -t $SESSION, or tmux kill-session -t $SESSION)" >&2; exit 1; }
DIR="$(cd "$DIR" && pwd -P)"

cmd_for() { # $1 = index starting at 1
  local cli="$MIX"; [ "$MIX" = mix ] && { [ $(( $1 % 2 )) -eq 1 ] && cli=codex || cli=agy; }
  case "$cli" in
    claude) echo "LINK_CLI=claude LINK_NAME=claude-$1 claude --model $MODEL" ;;
    codex) echo "codex -s read-only -a never -C '$DIR' -c 'mcp_servers.link.env.LINK_NAME=\"codex-$1\"' -c \"mcp_servers.link.env.LINK_PANE=\\\"\$TMUX_PANE\\\"\"" ;;
    agy)   echo "LINK_CLI=agy LINK_NAME=agy-$1 agy" ;;
  esac
}

tmux new-session -d -s "$SESSION" -x 220 -y 60 -c "$DIR" "$(cmd_for 1)"
for i in $(seq 2 "$COUNT"); do
  tmux split-window -t "$SESSION" -c "$DIR" "$(cmd_for "$i")"
  tmux select-layout -t "$SESSION" tiled >/dev/null   # re-tile after each split so the next split always has room
done
tmux select-layout -t "$SESSION" tiled >/dev/null
tmux set-option -t "$SESSION" pane-border-status top >/dev/null
echo "$COUNT panes in tmux session '$SESSION' ($MIX). Attach: tmux attach -t $SESSION   Stop: tmux kill-session -t $SESSION"
[ "$ATTACH" = 1 ] && exec tmux attach -t "$SESSION"
exit 0
