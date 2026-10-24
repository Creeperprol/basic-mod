#!/bin/bash
# Hook: print any inbox messages as context for the agent, then delete them. No model tokens spent while waiting.
# Event comes from $1 (PostToolUse | Stop). INBOX dir from $WAKE_INBOX.
EVENT="${1:-PostToolUse}"; BOX="${WAKE_INBOX:-$HOME/link-bridge/wake-tests/inbox}"
cat >/dev/null  # drain hook stdin
take() { local out=""; for f in "$BOX"/*.json; do [ -f "$f" ] || continue; out+="$(jq -r '"From \(.from): \(.text)"' "$f")"$'\n'; rm -f "$f"; done; printf '%s' "$out"; }
if [ "$EVENT" = Stop ]; then
  # wait in the shell (free) up to WAKE_WAIT seconds for a message
  for _ in $(seq 1 "${WAKE_WAIT:-20}"); do ls "$BOX"/*.json >/dev/null 2>&1 && break; sleep 1; done
  MSG="$(take)"; [ -n "$MSG" ] || exit 0
  jq -n --arg r "New inbox message(s), handle them: $MSG" '{decision:"block",reason:$r}'
else
  MSG="$(take)"; [ -n "$MSG" ] || exit 0
  jq -n --arg c "INBOX: $MSG" '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:$c}}'
fi
