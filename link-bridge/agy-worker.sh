#!/bin/bash
# Start an Antigravity CLI (agy) session as a link-bridge worker: it waits on link_inbox, does each task, and answers with link_report.
# The host (Claude Code, Codex, ...) hands it work with link_assign.
#
#   agy-worker.sh [-m MODEL] [-d DIR] [-w] [-n] [-p "extra instructions"]
#     -m MODEL   agy model id (see `agy models`); default gemini-3.8-flash-low
#     -d DIR     working folder (default: current folder); with -w it must already be trusted by agy (trustedWorkspaces in
#                settings.json), otherwise agy stops at a trust question; headless mode does not ask
#     -w         open a Terminal.app window (interactive agy, you can approve tool prompts there)
#                default: headless background session (print mode); tools other than the link tools are
#                auto-denied unless permissions.allow in ~/.gemini/antigravity-cli/settings.json lists them
#     -n         dry run: print the command and exit
#     -p TEXT    extra instructions appended to the worker prompt
#
# One-time setup:  agy mcp add --env LINK_CLI=agy link "$(command -v node)" /path/to/link-bridge/server.mjs
# and allow only the worker tools (no wildcards) in ~/.gemini/antigravity-cli/settings.json:
#   "permissions": { "allow": ["mcp(link/link_inbox)", "mcp(link/link_report)", "mcp(link/link_peers)", "mcp(link/link_tell)"] }
set -euo pipefail

MODEL="gemini-3.8-flash-low"; DIR="$PWD"; WINDOW=0; DRY=0; EXTRA=""
while getopts "m:d:wnp:" o; do
  case "$o" in
    m) MODEL="$OPTARG" ;;
    d) DIR="$OPTARG" ;;
    w) WINDOW=1 ;;
    n) DRY=1 ;;
    p) EXTRA="$OPTARG" ;;
    *) sed -n '2,16p' "$0"; exit 2 ;;
  esac
done

case "$MODEL" in *[!A-Za-z0-9._-]*) echo "invalid model name: $MODEL" >&2; exit 2 ;; esac
[ -d "$DIR" ] || { echo "no such folder: $DIR" >&2; exit 2; }
DIR="$(cd "$DIR" && pwd -P)"

# agy asks "Do you trust the contents of this project?" in a folder it does not trust yet, and an interactive window waits on that
# question forever. Read-only check against trustedWorkspaces; this script never trusts a folder for you.
SETTINGS="${AGY_SETTINGS:-$HOME/.gemini/antigravity-cli/settings.json}"
trusted() {
  python3 - "$SETTINGS" "$DIR" <<'PY'
import json, os, sys
try:
    entries = json.load(open(sys.argv[1])).get("trustedWorkspaces", [])
except Exception:
    sys.exit(0)  # unreadable settings: do not block
d = os.path.realpath(sys.argv[2])
for e in entries:
    r = os.path.realpath(os.path.expanduser(e))
    if d == r or d.startswith(r.rstrip("/") + "/"):
        sys.exit(0)
sys.exit(1)
PY
}
if [ "$WINDOW" = 1 ] && ! trusted; then
  echo "agy does not trust $DIR yet: an interactive window there would stop at \"Do you trust the contents of this project?\" and never start." >&2
  echo "Use a trusted folder (see trustedWorkspaces in $SETTINGS), or run agy there once yourself and answer the question. Headless mode (no -w) does not ask." >&2
  exit 3
fi

PROMPT="You are a worker in a multi-agent setup. Tasks arrive typed into your prompt as [link TASK <id> ...] lines. Do not poll or wait. When a TASK arrives, do exactly what it says, then call link_report with that task_id and a short result (what you did, what you verified, what you did not). Write no chat text. ${EXTRA}"

if [ "$WINDOW" = 1 ]; then
  q() { printf "'%s'" "${1//\'/\'\\\'\'}"; }
  CMD="cd $(q "$DIR") && agy --model $MODEL -i $(q "$PROMPT")"
  ESC="${CMD//\\/\\\\}"; ESC="${ESC//\"/\\\"}"
  SCRIPT="tell application \"Terminal\"
activate
do script \"$ESC\"
end tell"
  if [ "$DRY" = 1 ]; then echo "$CMD"; exit 0; fi
  osascript -e "$SCRIPT" >/dev/null
  echo "Opened an agy worker window in $DIR (model $MODEL)."
else
  if [ "$DRY" = 1 ]; then echo "cd $DIR && agy --model $MODEL -p <worker prompt>"; exit 0; fi
  LOG="$(mktemp -t agy-worker)"
  ( cd "$DIR" && nohup agy --model "$MODEL" -p "$PROMPT" >"$LOG" 2>&1 & )
  echo "Started a headless agy worker in $DIR (model $MODEL). Log: $LOG"
fi
