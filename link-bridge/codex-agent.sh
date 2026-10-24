#!/bin/bash
# Use the Codex CLI as a one-shot agent for another tool (Claude Code, ...): start `codex exec`, give it one task, wait, print its
# final message, let it exit. Same lifecycle as a subagent: nothing stays running.
#
#   codex-agent.sh [-d DIR] [-m MODEL] [-s SANDBOX] [-t SECONDS] [-o FILE] "the task"
#     -d DIR      working folder for the agent (default: current folder)
#     -m MODEL    Codex model (default: whatever ~/.codex/config.toml sets)
#     -s SANDBOX  read-only (default) | workspace-write   (danger-full-access is not offered)
#     -t SECS     give up after this long (default 600)
#     -o FILE     also copy the final message to FILE
#     -w          open a Terminal window that shows the agent working live (reasoning, commands, result)
#     -i IMAGE    attach an image so the agent can see it (repeat -i for several)
# Prints the agent's final message on stdout; exits 1 if it produced none or timed out.
# Safe by default: read-only sandbox, no approval bypass, session not kept on disk (--ephemeral).
set -euo pipefail

DIR="$PWD"; MODEL=""; SANDBOX="read-only"; LIMIT=600; OUTFILE=""; IMAGES=(); WATCH_WIN=0
while getopts "d:m:s:t:o:i:w" o; do
  case "$o" in
    d) DIR="$OPTARG" ;;
    m) MODEL="$OPTARG" ;;
    s) SANDBOX="$OPTARG" ;;
    t) LIMIT="$OPTARG" ;;
    o) OUTFILE="$OPTARG" ;;
    w) WATCH_WIN=1 ;;
    i) [ -f "$OPTARG" ] || { echo "no such image: $OPTARG" >&2; exit 2; }; IMAGES+=("$(cd "$(dirname "$OPTARG")" && pwd -P)/$(basename "$OPTARG")") ;;
    *) sed -n '2,14p' "$0"; exit 2 ;;
  esac
done
shift $((OPTIND - 1))
[ $# -ge 1 ] || { echo "give the task" >&2; exit 2; }
TASK="$*"
case "$SANDBOX" in read-only|workspace-write) ;; *) echo "invalid sandbox: $SANDBOX (use read-only or workspace-write)" >&2; exit 2 ;; esac
case "$MODEL" in *[!A-Za-z0-9._:/-]*) echo "invalid model name: $MODEL" >&2; exit 2 ;; esac
case "$LIMIT" in *[!0-9]*|"") echo "invalid -t" >&2; exit 2 ;; esac
[ -d "$DIR" ] || { echo "no such folder: $DIR" >&2; exit 2; }
DIR="$(cd "$DIR" && pwd -P)"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/codex-agent.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
ARGS=(exec --skip-git-repo-check --ephemeral -s "$SANDBOX" -C "$DIR" -o "$WORK/last.txt")
[ -n "$MODEL" ] && ARGS+=(-m "$MODEL")
for img in "${IMAGES[@]+"${IMAGES[@]}"}"; do ARGS+=(-i "$img"); done

if [ "$WATCH_WIN" = 1 ]; then
  : >"$WORK/stderr.txt"
  osascript -e "tell application \"Terminal\" to do script \"clear; echo 'codex-agent: working...'; tail -n +1 -f '$WORK/stderr.txt'; echo; echo '[codex finished]'\"" -e 'tell application "Terminal" to activate' >/dev/null 2>&1 || echo "could not open a Terminal window" >&2
fi

codex "${ARGS[@]}" -- "$TASK" >"$WORK/stdout.txt" 2>"$WORK/stderr.txt" </dev/null &
PID=$!
# The watchdog must not hold our stdout open, or a caller capturing the output would wait for it.
( sleep "$LIMIT"; kill -TERM "$PID" 2>/dev/null ) >/dev/null 2>&1 &
WATCH=$!
wait "$PID" 2>/dev/null || true
pkill -P "$WATCH" 2>/dev/null || true
kill "$WATCH" 2>/dev/null || true
wait "$WATCH" 2>/dev/null || true

if [ "$WATCH_WIN" = 1 ]; then sleep 2; pkill -f "tail -n \+1 -f $WORK/stderr.txt" 2>/dev/null || true; fi

if [ ! -s "$WORK/last.txt" ]; then
  echo "codex returned no final message (timed out after ${LIMIT}s or failed). stderr: $(tail -c 400 "$WORK/stderr.txt" 2>/dev/null)" >&2
  exit 1
fi
[ -n "$OUTFILE" ] && { mkdir -p "$(dirname "$OUTFILE")"; cp "$WORK/last.txt" "$OUTFILE"; }
cat "$WORK/last.txt"
