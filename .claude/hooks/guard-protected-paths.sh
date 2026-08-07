#!/usr/bin/env bash
#
# PreToolUse guard for Edit/Write against protected repository paths.
#
# Emits an "ask" decision with a path-specific reason so the agent learns WHY the
# path is protected and what precondition it must satisfy, rather than seeing an
# anonymous permission prompt. Hard prohibitions belong in `permissions.deny` in
# .claude/settings.json, not here — a deny rule cannot fail open, a hook can.
#
# Failure policy: FAIL CLOSED. Any inability to inspect the payload degrades to
# "ask" (a human prompt), never to silent approval.

set -euo pipefail

emit_ask() {
  # $1 = reason. Emitted via printf because jq may be the thing that is missing.
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"%s"}}' "$1"
  exit 0
}

if ! command -v jq >/dev/null 2>&1; then
  emit_ask "Project hook: jq is unavailable, so the protected-path guard could not run. Failing closed. Install jq (brew install jq) to restore automatic classification."
fi

payload=$(cat)
file_path=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // ""')

if [ -z "$file_path" ]; then
  exit 0 # No file path to classify (not an Edit/Write shape); defer to normal permission flow.
fi

# ── What belongs here, and what deliberately does not ─────────────────────
#
# Only ONE category remains: an edit under prisma/migrations/. It earns a
# prompt because the failure it prevents is silent, remote, and unrecoverable —
# editing an applied migration changes a checksum recorded in
# `_prisma_migrations`, and the damage surfaces mid-deploy in an environment
# nobody is watching. No amount of instruction in CLAUDE.md prevents that,
# because the agent cannot know from the repository alone whether a given
# migration has been applied somewhere. Only a human knows.
#
# Three categories were removed (prisma/schema.prisma, the auth/authorization
# trees, and src/common/errors/). Each was already gated twice over: CLAUDE.md
# states every one of those rules and is in the agent's context on every single
# request, and `/work-item`'s plan gate is where a human consciously approves
# touching those surfaces. A third check that fires on EVERY file edit adds no
# information a reader did not already have — a single authorization change
# legitimately touches thirty files, and thirty identical prompts do not make
# the reviewer thirty times more informed. They train the reviewer to click
# through without reading, which is strictly worse than one prompt they
# actually read. A guard that is always firing is indistinguishable from noise.
#
# Hard prohibitions are unaffected: they live in `permissions.deny` in
# .claude/settings.json, which cannot fail open and never prompts at all.
case "$file_path" in
  */prisma/migrations/*)
    emit_ask "Project hook: this edits a file under prisma/migrations/. Never edit an already-applied migration — its checksum is recorded in _prisma_migrations and editing it breaks 'migrate deploy' in every deployed environment. Approve ONLY for a migration that has not been applied anywhere (a fresh --create-only, or a template re-baseline before any deploy). Otherwise add a NEW migration."
    ;;
esac

exit 0 # Not a protected path; normal permission flow applies.
