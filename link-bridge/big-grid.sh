#!/bin/bash
# One tmux window: left 75% = 3 rows x 4 cols (codex / claude / agy), right 25% = one big claude.
set -euo pipefail
S=link-grid; DIR="$HOME"; MODEL=sonnet
tmux kill-session -t "$S" 2>/dev/null || true

codex_cmd()  { echo "codex --dangerously-bypass-approvals-and-sandbox -C '$DIR' -c 'mcp_servers.link.env.LINK_NAME=\"codex-$1\"' -c \"mcp_servers.link.env.LINK_PANE=\\\"\$TMUX_PANE\\\"\""; }
claude_cmd() { echo "LINK_CLI=claude LINK_NAME=claude-$1 claude --model $MODEL"; }
agy_cmd()    { echo "LINK_CLI=agy LINK_NAME=agy-$1 agy --dangerously-skip-permissions"; }

BIG=$(tmux new-session -d -s "$S" -x 220 -y 60 -c "$DIR" -P -F '#{pane_id}' "LINK_CLI=claude LINK_NAME=claude-big claude --model $MODEL")
ROW1=$(tmux split-window -hb -t "$BIG" -l 75% -c "$DIR" -P -F '#{pane_id}' "$(codex_cmd 1)")
ROW2=$(tmux split-window -v -t "$ROW1" -l 67% -c "$DIR" -P -F '#{pane_id}' "$(claude_cmd 1)")
ROW3=$(tmux split-window -v -t "$ROW2" -l 50% -c "$DIR" -P -F '#{pane_id}' "$(agy_cmd 1)")

fill_row() { # $1 first pane id, $2 command function
  local p="$1" fn="$2" pct n
  for n in 2 3 4; do
    case $n in 2) pct=75 ;; 3) pct=67 ;; 4) pct=50 ;; esac
    p=$(tmux split-window -h -t "$p" -l ${pct}% -c "$DIR" -P -F '#{pane_id}' "$($fn $n)")
  done
}
fill_row "$ROW1" codex_cmd
fill_row "$ROW2" claude_cmd
fill_row "$ROW3" agy_cmd
tmux set-option -t "$S" pane-border-status top >/dev/null
tmux select-pane -t "$BIG"
echo "12 small + 1 big claude in tmux session '$S'"
