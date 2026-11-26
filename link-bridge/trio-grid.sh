#!/bin/bash
# One tmux window: left 40% = codex (top) + agy (bottom), right 60% = one big claude.
set -euo pipefail
S=link-trio; DIR="$HOME"; MODEL=sonnet
tmux kill-session -t "$S" 2>/dev/null || true
CODEX="codex --dangerously-bypass-approvals-and-sandbox -C '$DIR' -c 'mcp_servers.link.env.LINK_NAME=\"codex-1\"' -c \"mcp_servers.link.env.LINK_PANE=\\\"\$TMUX_PANE\\\"\""
AGY="LINK_CLI=agy LINK_NAME=agy-1 agy --dangerously-skip-permissions"
BIG=$(tmux new-session -d -s "$S" -x 220 -y 60 -c "$DIR" -P -F '#{pane_id}' "env -u TMUX -u CLAUDECODE -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_SESSION_ATTENDED -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDE_CODE_MESSAGING_TOKEN -u CLAUDE_CODE_ENTRYPOINT -u AI_AGENT COLORTERM=truecolor LINK_CLI=claude LINK_NAME=claude-big claude --model $MODEL")
LEFT=$(tmux split-window -hb -t "$BIG" -l 40% -c "$DIR" -P -F '#{pane_id}' "$CODEX")
tmux split-window -v -t "$LEFT" -l 50% -c "$DIR" "$AGY"
tmux set-option -t "$S" pane-border-status top >/dev/null
tmux select-pane -t "$BIG"
echo "trio in tmux session '$S'"
