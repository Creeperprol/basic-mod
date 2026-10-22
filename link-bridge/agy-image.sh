#!/bin/bash
# Make one image with the Antigravity CLI, agent-style: start agy headless, give it one task, wait for the result, let it exit.
#
#   agy-image.sh [-o OUT.jpg] [-m MODEL] [-t SECONDS] "what the image should show"
#     -o OUT     where to copy the image (default ~/Projects/agy-images/<slug>.jpg)
#     -m MODEL   agy model that drives the tool (default gemini-3.8-flash-low; see `agy models`)
#     -t SECS    give up after this long (default 240)
# Prints the final image path on stdout; exits non-zero if no image came back.
# Runs from /tmp, which agy trusts; headless mode needs no permission rule for generate_image.
set -euo pipefail
OUT=""; MODEL="gemini-3.8-flash-low"; LIMIT=240
while getopts "o:m:t:" o; do
  case "$o" in o) OUT="$OPTARG" ;; m) MODEL="$OPTARG" ;; t) LIMIT="$OPTARG" ;; *) sed -n '2,10p' "$0"; exit 2 ;; esac
done
shift $((OPTIND - 1))
[ $# -ge 1 ] || { echo "give a description of the image" >&2; exit 2; }
DESC="$*"
case "$MODEL" in *[!A-Za-z0-9._-]*) echo "invalid model name: $MODEL" >&2; exit 2 ;; esac
case "$LIMIT" in *[!0-9]*|"") echo "invalid -t" >&2; exit 2 ;; esac

WORK="$(mktemp -d /tmp/agy-image.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
PROMPT="Use the generate_image tool to create exactly one image: ${DESC}. Then reply with only the absolute file path of the image, nothing else."
( cd /tmp && agy --model "$MODEL" --output-format json -p "$PROMPT" >"$WORK/out.json" 2>"$WORK/err.txt" ) &
PID=$!
# The watchdog must not hold our stdout open, or a caller capturing the output would wait for it.
( sleep "$LIMIT"; kill -TERM "$PID" 2>/dev/null ) >/dev/null 2>&1 &
WATCH=$!
wait "$PID" 2>/dev/null || true
pkill -P "$WATCH" 2>/dev/null || true
kill "$WATCH" 2>/dev/null || true
wait "$WATCH" 2>/dev/null || true

IMG="$(python3 - "$WORK/out.json" <<'PY'
import json, os, re, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
if d.get("status") != "SUCCESS":
    sys.exit(0)
for m in re.findall(r"(/[^\s\"']+\.(?:jpg|jpeg|png|webp))", d.get("response", "")):
    if os.path.isfile(m):
        print(m)
        break
PY
)"
if [ -z "$IMG" ]; then
  echo "no image came back from agy. Output: $(head -c 300 "$WORK/out.json" 2>/dev/null) $(head -c 300 "$WORK/err.txt" 2>/dev/null)" >&2
  exit 1
fi
if [ -z "$OUT" ]; then
  SLUG="$(printf '%s' "$DESC" | tr -c 'A-Za-z0-9' '-' | tr -s '-' | cut -c1-40 | sed 's/^-//;s/-$//')"
  mkdir -p "$HOME/Projects/agy-images"
  OUT="$HOME/Projects/agy-images/${SLUG:-image}.${IMG##*.}"
fi
mkdir -p "$(dirname "$OUT")"
cp "$IMG" "$OUT"
echo "$OUT"
