# Architectural Decision Records

Every material change to this API is decided here before it is built, and the
record stays in the repository afterwards.

## Why these are committed

An ADR is the durable artifact the engineering gates hand to each other. A
session can be lost, compacted, or resumed on another machine; the ADR is what
survives. `/gate-implement`, `/gate-review`, and `/gate-validate` each take an ADR path as
their argument, and a resumed session decides where to pick up by reading the
`Status:` line — not by asking the human to remember.

## Naming

```text
docs/adr/NNNN-kebab-slug.md
```

Sequential, zero-padded to four digits, never reused. `0001-…`, `0002-…`. The
number is assigned when the ADR is first written, not when it is accepted.

Start from `.claude/templates/adr.md`.

## Lifecycle

| Status | Meaning | Next gate |
|---|---|---|
| `DRAFT` | Design **in progress** and incomplete. Not ready to read for approval. | `/gate-design <path>` to continue |
| `PROPOSED` | Design complete, awaiting human approval. No source may be edited. | approve (below), or keep discussing |
| `ACCEPTED` | Explicitly approved by a human. | `/gate-implement <path>` |
| `SUPERSEDED by NNNN` | Replaced by a later decision. Keep the file. | — |
| `REJECTED` | Considered and declined. Keep the file: the rejected option is the record. | — |

`PROPOSED` is not permission to implement. Only a human moves an ADR to
`ACCEPTED`, and only an explicit approval does it.

A material divergence discovered during implementation requires an **amendment**
to the ADR and renewed approval — not a silent deviation and not a new ADR.

## How to approve an ADR

```text
/gate-approve docs/adr/NNNN-slug.md
```

The gate reads the decision, rejected alternatives, residual risk, non-goals, and
**every unresolved §14 row** back to you, asks for an explicit decision, then
writes the `Status:` line and §15 together. The approver comes from
`git config user.name` and the date from the system — nothing is retyped, and
nothing is invented.

What makes this a real gate is not who types the characters. It is that
`gate-approve` sets `disable-model-invocation: true`, so **Claude cannot invoke
it** — only you can — and Git writes are denied, so **your commit is still the
act of record**. Claude decides nothing here; it transcribes the decision you
made, and transcribes both fields at once so they cannot drift apart.

Unresolved §14 rows must be resolved or explicitly accepted as conditions, which
are then recorded verbatim. An ADR whose own §14 asks whether it should exist is
a candidate for rejection, and the gate will say so.

Rejection runs through the same command: `Status: REJECTED`, reason recorded, file
kept.

Then: `/gate-implement docs/adr/NNNN-slug.md`.

A hand edit still works — `yarn claude:validate` fails the build if the `Status:`
line and §15 disagree, so a half-finished manual approval cannot reach
`/gate-implement`. But there is no reason to prefer it.

## How to resume an unfinished ADR

An ADR is often left `DRAFT` at the end of a day, or handed to someone else. To
pick it up — in a new session, or as a different developer:

```text
/gate-design docs/adr/NNNN-slug.md
```

Passing a path rather than a requirement puts the gate in **resume mode**. It
reads the whole ADR, re-establishes repository reality, and continues from the
earliest incomplete section instead of redesigning from scratch.

Re-establishing reality is the point, not ceremony. An ADR written days ago cites
`path:line` evidence and describes current behavior in §2; `main` may have moved
underneath it. `CLAUDE.md` requires verifying factual claims against the source
before acting, and an ADR's own claims are not exempt — a stale §2 quietly
invalidates the options weighed on top of it.

**Leaving an ADR mid-design:** set `Status: DRAFT` and write what remains into
**§14 Open decisions and blockers** with an owner. §14 is the handoff contract —
whoever resumes reads it first. Do not park an unfinished ADR at `PROPOSED`:
that means "ready for your approval" and invites someone to accept a design that
was never finished.

## What lands here after the gates

`/gate-validate` produces an evidence table. It runs read-only and cannot write, so it
emits the table as a paste-ready block; file it under the ADR's
**§16 Validation record** so the decision and the proof it worked live together.

## Never delete an ADR

A superseded or rejected decision is the most valuable thing in this directory —
it is the only place that records what was considered and why it lost. Mark the
status and move on.
