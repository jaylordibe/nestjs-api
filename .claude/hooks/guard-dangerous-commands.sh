#!/usr/bin/env bash
#
# PreToolUse guard for Bash against operations CLAUDE.md reserves for the human.
#
# WHY THIS EXISTS ALONGSIDE permissions.deny
# ------------------------------------------
# A `permissions.deny` rule such as `Bash(git commit *)` matches a command
# PREFIX. It therefore cannot see the same operation expressed any other way:
#
#   git -C /repo commit -m x                  flag before the verb
#   dotenv -e .env -- prisma migrate deploy   environment runner
#   sudo npm publish                          privilege wrapper
#   cat .env                                  Read(.env) governs the Read tool, not the shell
#
# Claude Code strips a fixed wrapper list (timeout, time, nice, nohup, stdbuf,
# command, builtin, noglob, xargs) before matching deny rules, but its docs are
# explicit that environment runners such as dotenv, direnv exec, devbox run,
# mise exec and npx are NOT stripped. This hook parses the whole command,
# resolves the effective verb behind those forms, and closes that gap.
#
# WHAT THIS IS NOT
# ----------------
# Defence in depth, not a sandbox, and it must never be documented as one. A
# shell can always express an operation this parser does not model: a verb built
# from a variable, an operation inside a script file, a here-doc. The
# declarative `permissions.deny` floor stays the layer that cannot fail open for
# the exact forms it names; a real boundary needs OS sandboxing or a container.
#
# Failure policy: FAIL CLOSED. Any inability to inspect or classify the payload
# degrades to "ask" (a human prompt), never to silent approval.
#
# Behaviour is pinned by fixture tests in scripts/validate-claude-config.ts,
# which runs this script against a decision table on every `yarn claude:validate`
# and in CI. Change a rule here and the table there fails until it agrees.

set -euo pipefail

# Reason strings are interpolated into JSON by printf, so they must stay free of
# double quotes, backslashes and newlines. Keep each to one plain sentence.
emit_decision() {
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"%s","permissionDecisionReason":"%s"}}' "$1" "$2"
  exit 0
}

emit_deny() { emit_decision deny "Project hook: $1"; }
emit_ask() { emit_decision ask "Project hook: $1"; }

if ! command -v jq >/dev/null 2>&1; then
  emit_ask 'jq is unavailable, so the dangerous-command guard could not classify this call. Failing closed. Install jq (brew install jq) to restore automatic classification.'
fi

payload=$(cat)
raw_command=$(printf '%s' "$payload" | jq -r '.tool_input.command // ""')

if [ -z "$raw_command" ]; then
  exit 0 # Not a shell-shaped payload; defer to the normal permission flow.
fi

# ---------------------------------------------------------------------------
# Classification tables. Single-line, space-delimited, matched by contains_word.
# ---------------------------------------------------------------------------

# Commands that run their own argument list as another command. Resolving past
# these is the entire reason this hook exists.
COMMAND_WRAPPERS=' sudo doas command builtin exec env time nice nohup stdbuf caffeinate setsid ionice flock watch xargs timeout noglob nocorrect npx bunx pnpx dotenv direnv devbox mise rbenv asdf poetry pipenv '

# Wrappers that consume one bare (non-option) token before the real command:
# `timeout 30 …`, `flock lockfile …`, `direnv exec DIR …`, `devbox run …`.
WRAPPERS_CONSUMING_ONE_ARGUMENT=' timeout flock direnv devbox mise rbenv asdf poetry pipenv '

# Wrapper options that consume the following token as their value, so the token
# after them is an argument rather than the effective command.
WRAPPER_OPTIONS_TAKING_A_VALUE=' -e --env-file -n -C -u -w -f --file --cwd --dir --chdir -p --path -i --interval '

# Git subcommands that write history, move HEAD, discard work, or publish.
# Deliberately in lockstep with the Bash(git ...) deny rules in settings.json;
# validate-claude-config.ts fails the build when the two drift apart.
GIT_HUMAN_OWNED_SUBCOMMANDS=' commit push merge rebase tag reset clean stash checkout switch restore cherry-pick revert am apply remote filter-branch update-ref fast-import '

# Files whose contents are real credentials. `.env.test` and `.env.example` are
# deliberately absent: /gate-validate legitimately reads both.
READABLE_ENVIRONMENT_FILES=' .env.test .env.example '

# Commands that move a file's contents to stdout, a variable, a pipe, or another
# path. Touching a credential file with one of these is exposure, not inspection.
FILE_CONTENT_READERS=' cat bat less more head tail nl tac strings xxd od base64 grep egrep fgrep rg ag ack sed awk gawk jq yq tee dd cp install source . open pbcopy curl wget http '

# Commands that cannot read a file, so a credential path in their arguments is
# text rather than access. Keeps the guard quiet on ordinary narration.
INERT_COMMANDS=' echo printf true false : test '

contains_word() {
  case "$1" in
    *" $2 "*) return 0 ;;
    *) return 1 ;;
  esac
}

is_option_token() {
  case "$1" in
    -?*) return 0 ;;
    *) return 1 ;;
  esac
}

is_environment_assignment() {
  case "$1" in
    [A-Za-z_]*=*) return 0 ;;
    *) return 1 ;;
  esac
}

basename_of() {
  printf '%s' "${1##*/}"
}

strip_surrounding_quotes() {
  printf '%s' "$1" | tr -d "\"'"
}

# A protected secret path: any .env variant other than the two readable ones,
# plus private-key material. A glob such as `.env*` counts, since it expands
# onto a protected file.
is_protected_secret_path() {
  candidate=$(basename_of "$(strip_surrounding_quotes "$1")")

  if contains_word "$READABLE_ENVIRONMENT_FILES" "$candidate"; then
    return 1
  fi

  case "$candidate" in
    .env | .env.* | .env\* | *.pem | *.key | id_rsa* | id_ed25519* | *.p12 | *.pfx) return 0 ;;
    *) return 1 ;;
  esac
}

# Every non-option token of an argument list, space-delimited. `git -C /repo
# commit -m x` yields `commit x`, so the subcommand is simply the first word.
positional_arguments() {
  set -f # Never let a segment's own glob expand against the real filesystem.
  # shellcheck disable=SC2086 # Deliberate word splitting: we are tokenising.
  set -- $1
  set +f

  collected=''
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --) ;;
      -C | -c | --git-dir | --work-tree | --namespace | --exec-path | --config-env | -m | --message)
        if [ "$#" -gt 1 ]; then shift; fi
        ;;
      -?*) ;;
      *) collected="$collected $1" ;;
    esac
    shift
  done

  printf '%s' "${collected# }"
}

# The effective command of one segment: the first token that is not an
# environment assignment, an option, a `--` terminator, or a command wrapper.
# Prints `<command><TAB><remaining arguments>`.
resolve_effective_command() {
  set -f
  # shellcheck disable=SC2086
  set -- $1
  set +f

  while [ "$#" -gt 0 ]; do
    token=$1

    if [ "$token" = '--' ] || is_environment_assignment "$token"; then
      shift
      continue
    fi

    if is_option_token "$token"; then
      if contains_word "$WRAPPER_OPTIONS_TAKING_A_VALUE" "$token" && [ "$#" -gt 1 ]; then
        shift
      fi
      shift
      continue
    fi

    token_name=$(basename_of "$token")

    if contains_word "$COMMAND_WRAPPERS" "$token_name"; then
      shift
      if contains_word "$WRAPPERS_CONSUMING_ONE_ARGUMENT" "$token_name" &&
        [ "$#" -gt 0 ] && ! is_option_token "$1"; then
        shift
      fi
      continue
    fi

    shift
    printf '%s\t%s' "$token_name" "$*"
    return 0
  done

  printf '\t'
}

# ---------------------------------------------------------------------------
# Rules
# ---------------------------------------------------------------------------

# `rm -rf` aimed at a filesystem or home root is unrecoverable and never part of
# a legitimate change. Ordinary project-local cleanup stays unprompted.
classify_recursive_removal() {
  set -f
  # shellcheck disable=SC2086
  set -- $1
  set +f

  removal_is_recursive=false
  for token in "$@"; do
    case "$token" in
      --recursive) removal_is_recursive=true ;;
      --*) ;;
      -*r* | -*R*) removal_is_recursive=true ;;
    esac
  done
  [ "$removal_is_recursive" = true ] || return 0

  for token in "$@"; do
    if is_option_token "$token"; then continue; fi
    case "$(strip_surrounding_quotes "$token")" in
      / | /\* | '~' | '~/'* | '$HOME' | '$HOME/'* | '${HOME}'* | . | .. | ./ | ../ | '*')
        emit_deny 'this recursively removes a filesystem or home directory root. Destroying data outside the change under review is never part of an approved diff.'
        ;;
      /*)
        # An absolute path shallower than three segments is a system directory.
        path_depth=$(printf '%s' "$token" | tr -cd '/' | wc -c | tr -d ' ')
        if [ "$path_depth" -lt 3 ]; then
          emit_ask 'this recursively removes a top-level system path. Confirm the target is inside this project before approving.'
        fi
        ;;
    esac
  done
}

classify_credential_exposure() {
  effective_command=$1
  segment=$2

  if contains_word "$INERT_COMMANDS" "$effective_command"; then
    return 0
  fi

  set -f
  # shellcheck disable=SC2086
  set -- $segment
  set +f

  for token in "$@"; do
    if is_protected_secret_path "$token"; then
      if contains_word "$FILE_CONTENT_READERS" "$effective_command"; then
        emit_deny 'this reads or copies the contents of a real environment file or private key through the shell. A Read(.env) rule only governs the Read tool, so the shell is where this leaks. Use .env.example for shape and .env.test for test configuration, and ask the user for any value you genuinely need.'
      fi
      emit_ask 'this command references a real environment file or private key. Approve only if it neither reads nor copies the contents; .env.example and .env.test are the unrestricted alternatives.'
    fi
  done
}

classify_segment() {
  segment=$1

  resolution=$(resolve_effective_command "$segment")
  effective_command=${resolution%%	*}
  effective_arguments=${resolution#*	}
  [ -n "$effective_command" ] || return 0

  # The verb is classified before the credential scan: `dotenv -e .env --
  # prisma migrate deploy` names a credential file, but "this applies a
  # migration" is the finding that matters, and the more specific reason is the
  # one worth showing the human.
  words=$(positional_arguments "$effective_arguments")
  subcommand=${words%% *}
  remaining_words=${words#"$subcommand"}
  action=${remaining_words# }
  action=${action%% *}

  case "$effective_command" in
    git)
      if contains_word "$GIT_HUMAN_OWNED_SUBCOMMANDS" "$subcommand"; then
        emit_deny "git $subcommand writes history, moves HEAD, or discards work, and CLAUDE.md reserves every Git write for the human. Prepare the diff and let the user commit. Read-only inspection with status, diff, log, show and blame stays allowed."
      fi
      case "$subcommand" in
        worktree | branch)
          emit_ask "git $subcommand can create or delete refs. Approve only for a read-only listing."
          ;;
      esac
      ;;

    gh)
      case "$subcommand" in
        pr)
          case "$action" in
            create | merge | close | edit | ready | review)
              emit_deny "gh pr $action publishes or changes a pull request, which CLAUDE.md reserves for the human."
              ;;
          esac
          ;;
        release | workflow)
          emit_deny "gh $subcommand publishes a release or triggers a workflow, which CLAUDE.md reserves for the human."
          ;;
        api)
          emit_ask 'gh api reads or writes depending on its method. Approve read-only calls; a write method is a human-owned operation.'
          ;;
      esac
      ;;

    prisma)
      case "$subcommand" in
        migrate | db)
          emit_deny "prisma $subcommand applies schema or data changes to a database. CLAUDE.md forbids applying migrations locally: yarn build verifies the generated shape, and the e2e harness owns the isolated test database."
          ;;
      esac
      ;;

    yarn | npm | pnpm | bun)
      case "$subcommand" in
        prisma:migrate | prisma:deploy | prisma:reset | prisma:seed)
          emit_deny "$effective_command $subcommand applies migrations or rewrites database contents. CLAUDE.md leaves migration application to the human; verify the schema shape with yarn build."
          ;;
        publish)
          emit_deny "$effective_command publish releases this package. Publication is a human-owned operation."
          ;;
        prisma)
          case "$action" in
            migrate | db)
              emit_deny "$effective_command prisma $action applies schema or data changes to a database. Use yarn build to verify the generated Prisma shape instead."
              ;;
          esac
          ;;
      esac
      ;;

    docker | docker-compose)
      case "$subcommand" in
        push)
          emit_deny 'docker push publishes an image. Publication is a human-owned operation.'
          ;;
        volume)
          case "$action" in
            rm | prune)
              emit_deny 'docker volume rm or prune destroys database volumes, including the developer dev stack. Use yarn stack:down, which never passes -v.'
              ;;
          esac
          ;;
        system)
          if [ "$action" = 'prune' ]; then
            emit_deny 'docker system prune destroys volumes and images beyond this project. Use yarn stack:down.'
          fi
          ;;
        compose)
          if [ "$action" = 'down' ]; then
            emit_deny 'docker compose down tears down the stack and can destroy volumes. Use yarn stack:down, which never passes -v.'
          fi
          ;;
        down)
          emit_deny 'docker-compose down tears down the stack and can destroy volumes. Use yarn stack:down, which never passes -v.'
          ;;
        exec)
          emit_ask 'docker exec runs an arbitrary command inside a container, where this guard cannot classify it. Confirm the inner command is read-only.'
          ;;
      esac
      ;;

    dropdb | pg_dropcluster)
      emit_deny 'this drops a database. Destroying data is a human-owned operation, and the e2e harness owns the only database that may be dropped automatically.'
      ;;

    psql | mysql | redis-cli | mongosh)
      emit_ask "$effective_command opens a live database session. Approve only for read-only inspection against the dev or test stack, never against production."
      ;;

    rm)
      classify_recursive_removal "$effective_arguments"
      ;;
  esac

  classify_credential_exposure "$effective_command" "$segment"
}

# ---------------------------------------------------------------------------
# Walk every subcommand
# ---------------------------------------------------------------------------
# Claude Code treats &&, ||, ;, |, |&, & and newlines as command separators and
# matches each subcommand independently; command substitution hides one more
# level. Splitting on all of them means a guarded verb cannot be smuggled in as
# the tail of an otherwise innocent line.
#
# The loop must NOT run in a pipeline: emit_decision exits, and from a subshell
# that would print a decision and then let the remaining segments print more,
# producing two JSON objects on stdout.

while IFS= read -r segment; do
  case "$segment" in
    *[![:space:]]*) classify_segment "$segment" ;;
  esac
done <<SEGMENTS
$(printf '%s\n' "$raw_command" | tr ';|&()`' '\n\n\n\n\n\n')
SEGMENTS

exit 0 # Nothing matched; the normal permission flow applies.
