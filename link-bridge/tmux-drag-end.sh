#!/bin/sh
# Finish a tmux mouse selection wherever the mouse was released: copy it from the pane the drag
# started in (@drag_pane, set by the MouseDrag1Pane bindings) and leave copy mode, so the highlight
# never stays behind when the mouse ends up over another pane, a border or the status line.
#
#   tmux-drag-end.sh          copy + clear (bound to every MouseDragEnd1* key)
#   tmux-drag-end.sh <pane>   on a click in <pane>: clear a selection left in another pane
#                             (a release outside the terminal window never reaches tmux)
p=$(tmux show -gv @drag_pane 2>/dev/null)
[ -n "$p" ] || exit 0
[ -n "$1" ] && [ "$1" = "$p" ] && exit 0
[ "$(tmux display-message -p -t "$p" '#{pane_in_mode}' 2>/dev/null)" = 1 ] || { tmux set -gu @drag_pane; exit 0; }
if [ -n "$1" ]; then
  tmux send-keys -t "$p" -X cancel
else
  tmux send-keys -t "$p" -X copy-pipe-and-cancel "${TMUX_COPY_CMD:-pbcopy}"
fi
tmux set -gu @drag_pane
