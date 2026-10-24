#!/bin/bash
# Option 2: free shell loop watches the inbox; when a file appears, types a prompt into a Terminal tab (osascript do script). $1 = tab tty
BOX="$HOME/link-bridge/wake-tests/inbox2"; TTY="$1"; mkdir -p "$BOX"
while :; do
  f=$(ls "$BOX"/*.json 2>/dev/null | head -1)
  if [ -n "$f" ]; then
    txt=$(jq -r .text "$f"); rm -f "$f"
    osascript -e "tell application \"Terminal\" to repeat with w in windows
repeat with t in tabs of w
if tty of t is \"$TTY\" then do script \"$txt\" in t
end repeat
end repeat"
  fi
  sleep 1
done
