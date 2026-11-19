#!/bin/bash
# Copy a skill from ../skills/<name> into the skill folders of Claude Code, Antigravity (agy) and ~/.agents/skills so every CLI finds it.
#   install-skill.sh [name]      default: share
# Only copies into folders that already exist (the CLI is installed), and never overwrites a skill with local changes without saying so.
set -euo pipefail
NAME="${1:-share}"
case "$NAME" in *[!A-Za-z0-9_-]*|"") echo "invalid skill name" >&2; exit 2 ;; esac
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
SRC="$ROOT/skills/$NAME"; [ -f "$SRC/SKILL.md" ] || SRC="$ROOT/ai-link/skills/$NAME"
[ -f "$SRC/SKILL.md" ] || { echo "no such skill: $SRC/SKILL.md" >&2; exit 2; }
n=0
for base in "${SKILLS_DIRS:-$HOME/.claude/skills:$HOME/.gemini/antigravity-cli/skills:$HOME/.agents/skills}"; do
  IFS=: read -ra dirs <<<"$base"
  for d in "${dirs[@]}"; do
    [ -d "$d" ] || { echo "skip $d (not installed)"; continue; }
    if [ -f "$d/$NAME/SKILL.md" ] && ! cmp -s "$SRC/SKILL.md" "$d/$NAME/SKILL.md"; then echo "replacing the older $d/$NAME"; fi
    mkdir -p "$d/$NAME" && cp -R "$SRC/." "$d/$NAME/" && echo "installed $d/$NAME" && n=$((n + 1))
  done
done
[ "$n" -gt 0 ] || { echo "no skill folder found" >&2; exit 1; }
