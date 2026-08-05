---
name: gate-approve
description: Records a human's approval or rejection of a PROPOSED ADR in this repository after reading the decision, residual risk, non-goals, and unresolved blockers back to them, then writes the Status line and the approval section together and stops without implementing.
argument-hint: "<ADR path>"
disable-model-invocation: true
model: inherit
effort: high
---

# Approve or reject an ADR

ADR:

```text
$ARGUMENTS
```

## What this gate is

`disable-model-invocation: true` is the security control that makes this skill
safe: **Claude can never invoke it.** Only a human typing `/gate-approve` starts
it, so Claude cannot approve its own design no matter what it concludes.

Within that boundary, writing the decision down is mechanical work and belongs
to the agent. The human decides; this skill transcribes, and transcribes *both*
fields together so they can never disagree. The human still owns the commit —
Git writes are denied — so the commit remains the act of record.

**Never infer approval.** "Looks good", "nice", "ok" while discussing something
else is not an approval. If this skill was invoked, the user intends to decide
now; if their instruction is ambiguous about *which* decision, ask.

## 1. Read the ADR

Read it completely. Then check `Status:`:

| Status | Action |
|---|---|
| `PROPOSED` | Proceed. |
| `DRAFT` | **Stop.** The design is unfinished and is not ready to be judged. Direct the user to `/gate-design <path>` to complete it first. |
| `ACCEPTED` | **Stop.** Already approved. Changing an accepted design needs an ADR amendment and renewed approval, not a re-approval. |
| `REJECTED` / `SUPERSEDED by NNNN` | **Stop.** Say so; a new ADR supersedes it. |

## 2. Read it back before they decide

An approval nobody re-read is a rubber stamp, and the whole value of this gate is
that it is the last moment before source changes. Present, concisely:

- **§1/§5** — the recommendation and the decision, in your own words, not quoted;
- **§4** — what was rejected and the trade-off accepted by choosing this;
- **§6/§7** — contract and data impact, if any;
- **§8** — residual security and privacy risk;
- **§12** — rollback/roll-forward path;
- **§13** — what this deliberately does NOT do, since scope disappointment
  surfaces here more often than technical objection;
- **§14** — **every unresolved row, individually.**

Re-verify the ADR against the repository first if it is more than a few days old
or the worktree has moved. Approving a design whose §2 evidence has gone stale is
approving a decision about a codebase that no longer exists. Say plainly if
anything no longer holds, and recommend `/gate-design <path>` instead.

## 3. Unresolved blockers

If §14 has any unresolved row, the user must either resolve it or **explicitly
accept it as a condition**. Name each one and ask which. Do not let an open
blocker pass silently into `Conditions/accepted risks` — write down exactly what
they said they were accepting.

If a §14 row questions whether the ADR should exist at all, say so directly and
offer rejection as the live option it is.

## 4. Record the decision

Only after an explicit, unambiguous decision this turn.

Resolve the approver from `git config user.name` and the date from the system —
never invent either, and never ask the user to retype what Git already knows. If
`user.name` is unset, ask rather than guessing.

**On approval**, write both places in one pass:

```text
- **Status:** ACCEPTED
```

```text
## 15. Approval

- **Decision:** Approved
- **Approved by:** <git config user.name>
- **Date:** <YYYY-MM-DD>
- **Conditions/accepted risks:** <verbatim conditions, or "none">
```

**On rejection**, `Status: REJECTED` and `Decision: Rejected`, with the reason in
`Conditions/accepted risks`. Keep the file — a rejected ADR is the record of what
was considered and why it lost.

Change nothing else. Not §1–§14, not source, not tests, not configuration. If the
user wants the design altered, that is `/gate-design`, not an approval.

Run `yarn claude:validate` to confirm the two fields agree.

## 5. Stop

Do not implement, commit, push, or apply a migration. The user owns the commit
that makes this approval real.

## 6. Handoff

Follow `.claude/standards/gate-handoff.md`.

On approval, offer to continue into `/gate-implement <adr>` in this session, or
to stop so they run it themselves. Recommend stopping when the ADR is High or
Critical risk.

On rejection there is no next gate. Say what would have to change for a new ADR
to supersede this one, and stop.
