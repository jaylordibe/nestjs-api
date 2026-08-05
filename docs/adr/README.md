# Architectural Decision Records

Every material change to this API is decided here before it is built, and the
record stays in the repository afterwards.

## Why these are committed

An ADR is the durable artifact the engineering gates hand to each other. A
session can be lost, compacted, or resumed on another machine; the ADR is what
survives. `/implement`, `/diff-review`, and `/validate` each take an ADR path as
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
| `PROPOSED` | Written, awaiting human approval. No source may be edited. | `/design` or continue the approval discussion |
| `ACCEPTED` | Explicitly approved by a human. | `/implement <path>` |
| `SUPERSEDED by NNNN` | Replaced by a later decision. Keep the file. | — |
| `REJECTED` | Considered and declined. Keep the file: the rejected option is the record. | — |

`PROPOSED` is not permission to implement. Only a human moves an ADR to
`ACCEPTED`, and only an explicit approval does it.

A material divergence discovered during implementation requires an **amendment**
to the ADR and renewed approval — not a silent deviation and not a new ADR.

## What lands here after the gates

`/validate` produces an evidence table. It runs read-only and cannot write, so it
emits the table as a paste-ready block; file it under the ADR's
**§16 Validation record** so the decision and the proof it worked live together.

## Never delete an ADR

A superseded or rejected decision is the most valuable thing in this directory —
it is the only place that records what was considered and why it lost. Mark the
status and move on.
