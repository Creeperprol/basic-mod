#!/bin/bash
# Reap a process tree (or all unattached @autokill tmux sessions and their panes/children)
# using SIGTERM followed by SIGKILL so SIGHUP-ignoring CLIs (e.g. agy-real) cannot linger.
#
#   tmux-reap.sh pid <pid> [pid2 ...]
#   tmux-reap.sh sweep
set -euo pipefail

# collect_tree <space-separated root PIDs> [space-separated allowed TTYs]
collect_tree() {
  local roots="${1:-}"
  local allowed_ttys="${2:-}"
  [ -n "$roots" ] || return 0
  ps -Ao pid=,ppid=,tty= 2>/dev/null | awk -v roots="$roots" -v ttys="$allowed_ttys" -v self="$$" -v parent="$PPID" '
    BEGIN {
      protected[1] = 1
      protected[self] = 1
      protected[parent] = 1
      n = split(roots, r, /[[:space:]]+/)
      for (i = 1; i <= n; i++) {
        if (r[i] ~ /^[0-9]+$/ && r[i] > 1) root_req[r[i]] = 1
      }
      use_tty = 0
      nt = split(ttys, tlist, /[[:space:]]+/)
      for (i = 1; i <= nt; i++) {
        t = tlist[i]
        sub(/^\/dev\//, "", t)
        if (t != "" && t != "??" && t != "-") {
          tty_ok[t] = 1
          use_tty = 1
        }
      }
    }
    $1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ {
      p = $1; pp = $2; t = $3
      sub(/^\/dev\//, "", t)
      pid[++cnt] = p
      ppid[cnt] = pp
      parent_of[p] = pp
      tty_of[p] = t
    }
    END {
      # Protect this script and every ancestor up to PID 1 so we can never kill our own chain.
      cur = self
      for (step = 0; step < 64 && (cur in parent_of); step++) {
        protected[cur] = 1
        nxt = parent_of[cur]
        if (nxt == cur || nxt <= 1) break
        cur = nxt
      }
      for (rk in root_req) {
        if (root_req[rk] == 1 && !(rk in protected)) want[rk] = 1
      }
      changed = 1
      while (changed) {
        changed = 0
        for (i = 1; i <= cnt; i++) {
          c = pid[i]
          par = ppid[i]
          if ((par in want) && want[par] == 1 && !(c in want) && !(c in protected) && c > 1) {
            want[c] = 1
            changed = 1
          }
        }
      }
      for (p in want) {
        if (want[p] == 1 && !(p in protected) && p > 1) {
          if (use_tty) {
            if ((p in tty_of) && (tty_of[p] in tty_ok) && tty_of[p] != "??" && tty_of[p] != "-") {
              print p
            }
          } else {
            print p
          }
        }
      }
    }
  '
}

kill_collected() {
  local pids=("$@")
  [ ${#pids[@]} -gt 0 ] || return 0
  kill -TERM "${pids[@]}" 2>/dev/null || true
  sleep 0.5
  local alive=()
  for p in "${pids[@]}"; do
    if kill -0 "$p" 2>/dev/null; then
      alive+=("$p")
    fi
  done
  if [ ${#alive[@]} -gt 0 ]; then
    kill -KILL "${alive[@]}" 2>/dev/null || true
  fi
}

cmd="${1:-sweep}"
shift || true

case "$cmd" in
  pid)
    [ $# -gt 0 ] || exit 0
    pids=()
    while IFS= read -r p; do
      [ -n "$p" ] && pids+=("$p")
    done < <(collect_tree "$*" "")
    kill_collected "${pids[@]+"${pids[@]}"}"
    ;;
  sweep)
    command -v tmux >/dev/null || exit 0
    sessions="$(tmux list-sessions -F '#{session_name}	#{session_attached}	#{@autokill}' 2>/dev/null || true)"
    [ -n "$sessions" ] || exit 0
    all_roots=()
    all_ttys=()
    dead_sessions=()
    while IFS=$'\t' read -r sess attached autokill; do
      [ -n "$sess" ] || continue
      if [ "${attached:-0}" = "0" ] && [ "${autokill:-0}" = "1" ]; then
        while IFS=$'\t' read -r ppid ptty; do
          [ -n "$ppid" ] && all_roots+=("$ppid")
          [ -n "${ptty:-}" ] && all_ttys+=("$ptty")
        done < <(tmux list-panes -s -t "$sess" -F '#{pane_pid}	#{pane_tty}' 2>/dev/null || true)
        dead_sessions+=("$sess")
      fi
    done <<< "$sessions"
    [ ${#dead_sessions[@]} -gt 0 ] || exit 0

    pids=()
    if [ ${#all_roots[@]} -gt 0 ]; then
      while IFS= read -r p; do
        [ -n "$p" ] && pids+=("$p")
      done < <(collect_tree "${all_roots[*]}" "${all_ttys[*]+"${all_ttys[*]}"}")
    fi
    for sess in "${dead_sessions[@]}"; do
      tmux kill-session -t "$sess" 2>/dev/null || true
    done
    kill_collected "${pids[@]+"${pids[@]}"}"
    ;;
  *)
    echo "usage: $0 {pid <pid...>|sweep}" >&2
    exit 2
    ;;
esac
