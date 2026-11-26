#!/bin/bash
# Open a full-screen tmux workspace with N terminal or AI panes + the left-side picker controller.
#
#   ai-tmux [-n COUNT] [-m MODE] [-l LAYOUT] [-s SESSION] [-d DIR] [--no-sidebar] [--dry-run]
#     -n COUNT       number of panes, 1-8 (default: 3)
#     -m MODE        pane command: term (zsh), agy, claude, codex, mix (default: term)
#     -l LAYOUT      layout: big (1 big left + rest stacked right) or tiled (default: big)
#     -s SESSION     tmux session name (default: term-<COUNT>)
#     -d DIR         starting directory (default: current directory)
#     --no-sidebar   omit the left-side picker.mjs controller pane
#     --dry-run      print the plan without launching tmux or Terminal
set -euo pipefail

SELF="$0"
while [ -L "$SELF" ]; do
  LINK="$(readlink "$SELF")"
  case "$LINK" in
    /*) SELF="$LINK" ;;
    *) SELF="$(dirname "$SELF")/$LINK" ;;
  esac
done
HERE="$(cd "$(dirname "$SELF")" && pwd -P)"

COUNT=3
MODE="term"
LAYOUT="big"
SESSION=""
DIR="$PWD"
SIDEBAR=1
DRY=0

while [ $# -gt 0 ]; do
  case "$1" in
    -n) COUNT="${2:?missing count}"; shift 2 ;;
    -m) MODE="${2:?missing mode}"; shift 2 ;;
    -l) LAYOUT="${2:?missing layout}"; shift 2 ;;
    -s) SESSION="${2:?missing session}"; shift 2 ;;
    -d) DIR="${2:?missing dir}"; shift 2 ;;
    --no-sidebar) SIDEBAR=0; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; sed -n '2,12p' "$0" >&2; exit 2 ;;
  esac
done

case "$COUNT" in 1|2|3|4|5|6|7|8) ;; *) echo "-n must be 1 to 8" >&2; exit 2 ;; esac
case "$MODE" in term|agy|claude|codex|mix) ;; *) echo "-m must be term, agy, claude, codex or mix" >&2; exit 2 ;; esac
case "$LAYOUT" in big|tiled) ;; *) echo "-l must be big or tiled" >&2; exit 2 ;; esac
[ -d "$DIR" ] || { echo "no such folder: $DIR" >&2; exit 2; }
DIR="$(cd "$DIR" && pwd -P)"

if [ -z "$SESSION" ]; then
  SESSION="${MODE}-${COUNT}"
fi
case "$SESSION" in *[!A-Za-z0-9_-]*|"") echo "invalid session name: $SESSION" >&2; exit 2 ;; esac

NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || { echo "node is required" >&2; exit 1; }

if [ "$DRY" = 1 ]; then
  echo "ai-tmux session=$SESSION count=$COUNT mode=$MODE layout=$LAYOUT sidebar=$SIDEBAR dir=$DIR"
  exit 0
fi

command -v tmux >/dev/null || { echo "tmux is required (brew install tmux)" >&2; exit 2; }
if tmux has-session -t "$SESSION" 2>/dev/null; then
  SESSION="${SESSION}-$(date +%H%M%S)"
fi

cmd_for() {
  local idx="$1" cli="$MODE"
  if [ "$MODE" = "mix" ]; then
    [ $((idx % 2)) -eq 1 ] && cli="codex" || cli="agy"
  fi
  case "$cli" in
    term)   echo "" ;;
    claude) echo "env -u TMUX -u CLAUDECODE -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_SESSION_ATTENDED -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDE_CODE_MESSAGING_TOKEN -u CLAUDE_CODE_ENTRYPOINT -u AI_AGENT COLORTERM=truecolor LINK_CLI=claude LINK_NAME=claude-$idx claude" ;;
    codex)  echo "codex --dangerously-bypass-approvals-and-sandbox -C '$DIR' -c 'mcp_servers.link.env.LINK_NAME=\"codex-$idx\"' -c \"mcp_servers.link.env.LINK_PANE=\\\"\\$TMUX_PANE\\\"\"" ;;
    agy)    echo "LINK_CLI=agy LINK_NAME=agy-$idx agy --dangerously-skip-permissions" ;;
  esac
}

FIRST_CMD="$(cmd_for 1)"
if [ -n "$FIRST_CMD" ]; then
  MAIN=$(tmux new-session -d -s "$SESSION" -x 220 -y 60 -c "$DIR" -P -F '#{pane_id}' "$FIRST_CMD")
else
  MAIN=$(tmux new-session -d -s "$SESSION" -x 220 -y 60 -c "$DIR" -P -F '#{pane_id}')
fi

if [ "$COUNT" -gt 1 ]; then
  if [ "$LAYOUT" = "big" ]; then
    C2="$(cmd_for 2)"
    if [ -n "$C2" ]; then
      RIGHT=$(tmux split-window -h -t "$MAIN" -p 40 -c "$DIR" -P -F '#{pane_id}' "$C2")
    else
      RIGHT=$(tmux split-window -h -t "$MAIN" -p 40 -c "$DIR" -P -F '#{pane_id}')
    fi
    for i in $(seq 3 "$COUNT"); do
      CI="$(cmd_for "$i")"
      if [ -n "$CI" ]; then
        RIGHT=$(tmux split-window -v -t "$RIGHT" -c "$DIR" -P -F '#{pane_id}' "$CI")
      else
        RIGHT=$(tmux split-window -v -t "$RIGHT" -c "$DIR" -P -F '#{pane_id}')
      fi
    done
  else
    for i in $(seq 2 "$COUNT"); do
      CI="$(cmd_for "$i")"
      if [ -n "$CI" ]; then
        tmux split-window -t "$SESSION" -c "$DIR" "$CI"
      else
        tmux split-window -t "$SESSION" -c "$DIR"
      fi
      tmux select-layout -t "$SESSION" tiled >/dev/null
    done
  fi
fi

if [ "$SIDEBAR" = 1 ]; then
  tmux split-window -hb -f -t "$MAIN" -l 32 -c "$DIR" "'$NODE_BIN' '$HERE/picker.mjs' --tmux-sidebar --dir '$DIR'"
fi

tmux select-pane -t "$MAIN"
tmux set-option -t "$SESSION" mouse on >/dev/null
tmux set-option -t "$SESSION" pane-border-status top >/dev/null

if [ "$(uname -s)" = "Darwin" ]; then
  osascript <<EOF >/dev/null
use framework "AppKit"
use scripting additions
try
  set f to current application's NSScreen's mainScreen()'s frame()
  set screenW to (item 1 of item 2 of f) as integer
  set screenH to (item 2 of item 2 of f) as integer
on error
  set screenW to 1440
  set screenH to 900
end try
tell application "Terminal"
  activate
  do script "tmux attach -t $SESSION"
  delay 0.25
  set bounds of front window to {0, 25, screenW, screenH}
end tell
EOF
fi

echo "Opened tmux session '$SESSION' ($COUNT $MODE panes, layout=$LAYOUT, sidebar=$SIDEBAR)."
