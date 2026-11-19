#!/bin/bash
# Open a Claude Code window as a link-bridge worker. Meant to be called by another CLI (Antigravity agy, Codex) that wants Claude to
# take a task: the window is always visible (no headless mode), registers with the link bridge as <name>, waits for a [link TASK] and
# answers with link_report.
#
#   claude-worker.sh [-d DIR] [-m MODEL] [-N NAME] [-p "first task or extra instructions"] [-n]
#     -d DIR    working folder (default: current folder); Claude Code must already trust it (read from ~/.claude.json, never changed)
#     -m MODEL  haiku | sonnet | opus (or a full model id); default: Claude's own default
#     -N NAME   link name (default claude-<4 random chars>), the name to use with link_assign / link_tell
#     -p TEXT   appended to the worker prompt; put the task here to start it at once
#     -n        dry run: print the command and exit
# Needs the link MCP server added to Claude once:  claude mcp add link --scope user -e LINK_CLI=claude -- node /path/to/server.mjs
set -euo pipefail
DIR="$PWD"; MODEL=""; NAME="claude-$(od -An -N2 -tx1 /dev/urandom | tr -d " \n")"; EXTRA=""; DRY=0
while getopts "d:m:N:p:n" o; do
  case "$o" in d) DIR="$OPTARG" ;; m) MODEL="$OPTARG" ;; N) NAME="$OPTARG" ;; p) EXTRA="$OPTARG" ;; n) DRY=1 ;; *) sed -n '2,12p' "$0"; exit 2 ;; esac
done
case "$MODEL" in *[!A-Za-z0-9._:\[\]-]*) echo "invalid model name: $MODEL" >&2; exit 2 ;; esac
case "$NAME" in *[!A-Za-z0-9_-]*|"") echo "invalid name: $NAME" >&2; exit 2 ;; esac
[ -d "$DIR" ] || { echo "no such folder: $DIR" >&2; exit 2; }
DIR="$(cd "$DIR" && pwd -P)"

# A window in a folder Claude Code does not trust stops at "Do you trust this folder?" and never starts. Read-only check.
CFG="${CLAUDE_JSON:-$HOME/.claude.json}"
python3 - "$CFG" "$DIR" <<'PY' || { echo "Claude Code does not trust $DIR yet: a window there would stop at the trust prompt. Use a trusted folder (or one under it), or run claude there once and accept." >&2; exit 3; }
import json, os, sys
try:
    projects = json.load(open(sys.argv[1])).get("projects", {})
except Exception:
    sys.exit(0)  # unreadable config: do not block
d = os.path.realpath(sys.argv[2])
while True:
    if projects.get(d, {}).get("hasTrustDialogAccepted") is True:
        sys.exit(0)
    up = os.path.dirname(d)
    if up == d:
        sys.exit(1)
    d = up
PY

PROMPT="You are a worker in a multi-agent setup, linked as $NAME. Tasks arrive typed into your prompt as [link TASK <id> ...] lines. Do exactly what a TASK says, then call link_report with that task_id and a short result (what you did, what you verified, what you did not). Write no chat text between tool calls. $EXTRA"
q() { printf "'%s'" "${1//\'/\'\\\'\'}"; }
CMD="cd $(q "$DIR") && env LINK_CLI=claude LINK_NAME=$NAME CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000 claude${MODEL:+ --model $MODEL} $(q "$PROMPT")"
if [ "$DRY" = 1 ]; then echo "$CMD"; exit 0; fi
ESC="${CMD//\\/\\\\}"; ESC="${ESC//\"/\\\"}"
osascript -e "tell application \"Terminal\"
activate
do script \"$ESC\"
end tell" >/dev/null
echo "Opened a Claude worker window in $DIR as $NAME${MODEL:+ (model $MODEL)}. Hand it work with link_assign to \"$NAME\"."
