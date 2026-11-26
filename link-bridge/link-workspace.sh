#!/bin/bash
# Open a tmux workspace with a persistent left-side session picker for Claude, Codex and agy.
# Picking (or clicking) any session in the left sidebar swaps it into the right-hand main pane
# while keeping the left sidebar pinned.
#
#   link-workspace.sh [-d DIR] [-s SESSION] [-m MODE] [-M MODEL] [-w COLS] [-a] [-n]
#     -d DIR      folder every session starts in (default: current folder)
#     -s SESSION  tmux session name (default: ai-link)
#     -m MODE     sessions to start: "all" (claude + codex + agy), "claude", "codex", or "agy" (default: all)
#     -M MODEL    model for claude sessions (default: sonnet)
#     -w COLS     left sidebar width in columns, 22-60 (default: 32)
#     -a          attach to the tmux session when ready
#     -n          dry run: validate arguments and print the workspace plan without starting tmux
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd -P)"
DIR="$PWD"
SESSION="ai-link"
MODE="all"
MODEL="sonnet"
WIDTH=32
ATTACH=0
DRY=0

while getopts "d:s:m:M:w:anh" o; do
  case "$o" in
    d) DIR="$OPTARG" ;;
    s) SESSION="$OPTARG" ;;
    m) MODE="$OPTARG" ;;
    M) MODEL="$OPTARG" ;;
    w) WIDTH="$OPTARG" ;;
    a) ATTACH=1 ;;
    n) DRY=1 ;;
    h) sed -n '2,14p' "$0"; exit 0 ;;
    *) sed -n '2,14p' "$0" >&2; exit 2 ;;
  esac
done

case "$MODE" in all|claude|codex|agy) ;; *) echo "-m must be all, claude, codex or agy" >&2; exit 2 ;; esac
case "$MODEL" in *[!A-Za-z0-9._:-]*|"") echo "invalid model name" >&2; exit 2 ;; esac
case "$SESSION" in *[!A-Za-z0-9_-]*|"") echo "invalid session name" >&2; exit 2 ;; esac
case "$WIDTH" in ''|*[!0-9]*) echo "-w must be a number (22-60)" >&2; exit 2 ;; esac
[ "$WIDTH" -ge 22 ] && [ "$WIDTH" -le 60 ] || { echo "-w must be between 22 and 60" >&2; exit 2; }
[ -d "$DIR" ] || { echo "no such folder: $DIR" >&2; exit 2; }
DIR="$(cd "$DIR" && pwd -P)"

NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || { echo "node is required" >&2; exit 1; }
PICKER="$HERE/picker.mjs"

if [ "$DRY" = 1 ]; then
  echo "workspace session=$SESSION mode=$MODE width=$WIDTH dir=$DIR model=$MODEL picker=$PICKER"
  exit 0
fi

command -v tmux >/dev/null || { echo "tmux is required (brew install tmux)" >&2; exit 2; }
if tmux has-session -t "$SESSION" 2>/dev/null; then
  if [ "$ATTACH" = 1 ]; then
    exec tmux attach -t "$SESSION"
  fi
  echo "session '$SESSION' already exists (attach: tmux attach -t $SESSION, stop: tmux kill-session -t $SESSION)" >&2
  exit 1
fi

claude_cmd() {
  echo "env -u TMUX -u CLAUDECODE -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_SESSION_ATTENDED -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDE_CODE_MESSAGING_TOKEN -u CLAUDE_CODE_ENTRYPOINT -u AI_AGENT COLORTERM=truecolor LINK_CLI=claude LINK_NAME=$1 claude --model $MODEL"
}
codex_cmd() {
  echo "codex --dangerously-bypass-approvals-and-sandbox -C '$DIR' -c 'mcp_servers.link.env.LINK_NAME=\"$1\"' -c \"mcp_servers.link.env.LINK_PANE=\\\"\$TMUX_PANE\\\"\""
}
agy_cmd() {
  echo "LINK_CLI=agy LINK_NAME=$1 agy --dangerously-skip-permissions"
}

PICKER_CMD="'$NODE_BIN' '$PICKER' --tmux-sidebar --dir '$DIR'"

# Create workspace window with the first agent on the right, then split the left sidebar pane.
case "$MODE" in
  all|claude) FIRST_NAME="claude-1"; FIRST_CMD="$(claude_cmd claude-1)" ;;
  codex)      FIRST_NAME="codex-1";  FIRST_CMD="$(codex_cmd codex-1)" ;;
  agy)        FIRST_NAME="agy-1";    FIRST_CMD="$(agy_cmd agy-1)" ;;
esac

MAIN_PANE=$(tmux new-session -d -s "$SESSION" -n "workspace" -x 220 -y 60 -c "$DIR" -P -F '#{pane_id}' "$FIRST_CMD")
SIDEBAR_PANE=$(tmux split-window -hb -t "$MAIN_PANE" -l "$WIDTH" -c "$DIR" -P -F '#{pane_id}' "$PICKER_CMD")

# In "all" mode, start Codex and agy in parked windows so clicking them on the left swaps them right in.
if [ "$MODE" = "all" ]; then
  tmux new-window -d -t "$SESSION" -n "codex-1" -c "$DIR" "$(codex_cmd codex-1)"
  tmux new-window -d -t "$SESSION" -n "agy-1"   -c "$DIR" "$(agy_cmd agy-1)"
fi

tmux set-option -t "$SESSION" mouse on >/dev/null
tmux set-option -t "$SESSION" pane-border-status top >/dev/null
tmux select-pane -t "$SIDEBAR_PANE" -T "ai-link picker" >/dev/null
tmux select-pane -t "$MAIN_PANE" -T "$FIRST_NAME" >/dev/null
tmux select-pane -t "$MAIN_PANE" >/dev/null

echo "Workspace '$SESSION' ready ($MODE) with left-side session picker (${WIDTH} cols). Attach: tmux attach -t $SESSION   Stop: tmux kill-session -t $SESSION"
[ "$ATTACH" = 1 ] && exec tmux attach -t "$SESSION"
exit 0
