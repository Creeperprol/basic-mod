#!/bin/bash
# Open the AI Link full-screen session picker (3 big tables for agy, claude, codex)
# showing all running and recent past resumable sessions.
#
#   picker [-w WIDTH_PX] [-d DIR] [--inline] [--tmux] [--live-only] [--past-limit N] [-n]
#   picker [--list | --json | --focus <name|id> | --continue <claude|codex|agy>]
#     -w WIDTH_PX      optional narrow sidebar width in pixels on macOS (default: full screen)
#     -d DIR           default folder for spawning/continuing sessions (default: current folder)
#     --inline         run the picker inside the current terminal instead of opening a new window
#     --tmux           open/resume/continue sessions inside tmux windows (attaching if needed)
#     --live-only      hide past/resumable sessions
#     --past-limit N   max past sessions per CLI (default: all)
#     --list / --json  list sessions and exit
#     --focus TARGET   focus a live session or resume a past session by name/id and exit
#     --continue CLI   continue the latest claude, codex or agy session and exit
#     -n               dry run: print the command without opening Terminal
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
WIDTH=""
DIR="$PWD"
INLINE=0
DRY=0
ONESHOT=0
EXTRA_ARGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    -w) WIDTH="${2:?missing width}"; shift 2 ;;
    -d) DIR="${2:?missing dir}"; shift 2 ;;
    --inline) INLINE=1; shift ;;
    -n) DRY=1; shift ;;
    --list|--json) ONESHOT=1; EXTRA_ARGS+=("$1"); shift ;;
    --focus|--continue) ONESHOT=1; EXTRA_ARGS+=("$1" "${2:?missing value for $1}"); shift 2 ;;
    --live-only|--tmux) EXTRA_ARGS+=("$1"); shift ;;
    --past-limit) EXTRA_ARGS+=("$1" "${2:?missing value for $1}"); shift 2 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; sed -n '2,15p' "$0" >&2; exit 2 ;;
  esac
done

if [ -n "$WIDTH" ]; then
  case "$WIDTH" in
    ''|*[!0-9]*) echo "-w must be a positive integer (pixels)" >&2; exit 2 ;;
  esac
  [ "$WIDTH" -ge 180 ] && [ "$WIDTH" -le 2000 ] || { echo "-w must be between 180 and 2000" >&2; exit 2; }
fi
[ -d "$DIR" ] || { echo "no such folder: $DIR" >&2; exit 2; }
DIR="$(cd "$DIR" && pwd -P)"

NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || { echo "node is required" >&2; exit 1; }

PICKER="$HERE/picker.mjs"

if [ "$ONESHOT" = 1 ]; then
  if [ "$DRY" = 1 ]; then
    echo "'$NODE_BIN' '$PICKER' --dir '$DIR' ${EXTRA_ARGS[*]}"
    exit 0
  fi
  exec "$NODE_BIN" "$PICKER" --dir "$DIR" "${EXTRA_ARGS[@]}"
fi

CMD="'$NODE_BIN' '$PICKER' --dir '$DIR'"
for arg in "${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}"; do
  CMD="$CMD '${arg//\'/\'\\\'\'}'"
done

if [ "$INLINE" = 1 ]; then
  if [ "$DRY" = 1 ]; then
    echo "$CMD"
    exit 0
  fi
  exec "$NODE_BIN" "$PICKER" --dir "$DIR" "${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}"
fi

if [ "$DRY" = 1 ]; then
  if [ -n "$WIDTH" ]; then
    echo "sidebar(${WIDTH}px): $CMD"
  else
    echo "fullscreen: $CMD"
  fi
  exit 0
fi

if [ "$(uname -s)" != "Darwin" ]; then
  exec "$NODE_BIN" "$PICKER" --dir "$DIR" "${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}"
fi

ESC_CMD="${CMD//\\/\\\\}"
ESC_CMD="${ESC_CMD//\"/\\\"}"

if [ -n "$WIDTH" ]; then
  BOUNDS_EXPR="{0, 25, $WIDTH, screenH}"
  MSG="Opened AI Link left-side session picker (${WIDTH}px)."
else
  BOUNDS_EXPR="{0, 25, screenW, screenH}"
  MSG="Opened AI Link full-screen session picker."
fi

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
  do script "$ESC_CMD"
  delay 0.25
  set bounds of front window to $BOUNDS_EXPR
end tell
EOF
echo "$MSG"
