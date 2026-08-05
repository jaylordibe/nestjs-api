#!/usr/bin/env bash
#
# PostToolUse formatter. After Claude edits a TypeScript file inside this
# repository, format and auto-fix that single file so `yarn lint` stays green
# continuously instead of accumulating violations until the validation gate.
#
# Scope is deliberately narrow: one file, only under src/ or test/, only .ts.
# This hook must never fail the turn — formatting is a convenience, not a gate.
# The authoritative check remains `yarn lint` in the validate gate and in CI.

set -uo pipefail

command -v jq >/dev/null 2>&1 || exit 0

payload=$(cat)
file_path=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // ""')

case "$file_path" in
  *.ts) ;;
  *) exit 0 ;;
esac

case "$file_path" in
  */src/*|*/test/*) ;;
  *) exit 0 ;;
esac

[ -f "$file_path" ] || exit 0

project_dir="${CLAUDE_PROJECT_DIR:-$(pwd)}"
cd "$project_dir" || exit 0

# Best effort, always non-blocking: a formatter failure must not stop the agent.
yarn --silent prettier --write "$file_path" >/dev/null 2>&1 || true
yarn --silent eslint --fix "$file_path" >/dev/null 2>&1 || true

exit 0
