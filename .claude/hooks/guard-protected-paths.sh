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

case "$file_path" in
  */prisma/migrations/*)
    emit_ask "Project hook: this edits a file under prisma/migrations/. Never edit an already-applied migration — its checksum is recorded in _prisma_migrations and editing it breaks 'migrate deploy' in every deployed environment. Approve ONLY for a migration that has not been applied anywhere (fresh --create-only). Otherwise add a NEW migration."
    ;;
  */prisma/schema.prisma)
    emit_ask "Project hook: this edits prisma/schema.prisma — HIGH risk per CLAUDE.md (schema, migrations, existing data). Confirm an ACCEPTED ADR covers this change, that the schema change is consolidated into ONE migration file, and that no migration will be applied to the local dev database."
    ;;
  */src/modules/auth/*|*/src/modules/authorization/*|*/src/common/authorization/*)
    emit_ask "Project hook: this edits an authentication/authorization surface — HIGH risk per CLAUDE.md. Confirm an ACCEPTED ADR exists, an explicit threat model was recorded, and negative + cross-tenant authorization tests are part of this change. See the auth-security and authorization skills."
    ;;
  */src/common/errors/*)
    emit_ask "Project hook: this edits the error contract (src/common/errors/). errorCode values are a stable machine-readable contract that web and mobile clients program against. Confirm consumers, mixed-version behavior, and rollback are identified per CLAUDE.md, and see src/common/errors/README.md."
    ;;
esac

exit 0 # Not a protected path; normal permission flow applies.
