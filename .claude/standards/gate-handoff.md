# Gate handoff contract

Every engineering gate ends the same way. A developer must never finish a gate
wondering what happens next, and must never have to reconstruct the path from
memory or from `CLAUDE.md`.

This file is the single source of that behaviour. Each gate references it rather
than restating it, so the sequence can only be changed in one place.

## 1. Close the gate

State, in this order and nothing more:

1. **Outcome** — one line. What this gate concluded.
2. **What changed on disk** — the ADR and its new `Status:`, the files touched,
   or explicitly "nothing changed" for a read-only gate.
3. **Evidence** — only checks that actually ran, with their real result. A gate
   that could not run something says `BLOCKED`, never silence.
4. **Anything that blocks the next gate** — unresolved §14 rows, failing checks,
   Critical/High findings, missing prerequisites.

## 2. Name the next step concretely

Print the next command **with its argument already filled in**, so it can be run
without the developer looking anything up:

```text
/gate-implement docs/adr/0007-rate-limit-otp-endpoint.md
```

Never write `/gate-implement <ADR path>` in a handoff. The placeholder is for
documentation; the handoff is for doing.

The sequence:

| Just finished | Next | Skip only when |
|---|---|---|
| `/gate-design` | `/gate-approve <adr>` | the design is still `DRAFT` — say so and stop; or the change is **Low risk and has no ADR**, in which case the next step is implementation and there is nothing to approve |
| `/gate-approve` | `/gate-implement <adr>` | decision was Rejected |
| `/gate-implement` | `/gate-review <adr>` | never |
| `/gate-review` | `/gate-validate <adr>` | a Critical/High finding is unresolved |
| `/gate-validate` | human commit / PR | verdict is `FAIL` or `BLOCKED` |

## 3. Offer to continue

Ask with `AskUserQuestion` — a real choice, not a rhetorical one. Keep it to one
question, and make the options honest about what actually happens:

- **Yes, continue now** — proceed in this session, following the next gate's
  `SKILL.md` as its authoritative contract. This is the same mechanism `/work-item`
  uses for stages 2–5; it is a continuation of work the user just authorised, not
  Claude deciding to run a gate on its own.
- **Stop here** — the user runs the next gate themselves, in a fresh session.
- A third option only when the state warrants one: *Revise the design*,
  *Reject the ADR*, *Fix findings first*.

If the user declines, stop cleanly. Do not re-ask, and do not drift into the next
gate's work anyway.

### When to recommend a fresh session instead

Say so plainly, and make **Stop here** the recommended option, when:

- the change is **High or Critical** risk, and the next gate is `/gate-review` —
  a review carries more weight from a context that did not just write the code;
- the conversation is long enough that compaction has already occurred, so the
  next gate would start from a summary rather than the real diff;
- the previous gate ended `FAIL` or `BLOCKED`.

Independence is a property of the review, not a formality. Continuing is a
convenience for ordinary work, not the default for risky work.

## 4. What continuing never authorises

Continuing carries the user's authorisation for the **next gate only**. It never
authorises:

- skipping a gate in the sequence;
- committing, pushing, opening a PR, tagging, or deploying;
- applying a migration or touching a database;
- approving an ADR the user has not explicitly decided on;
- reporting a check as passed when it did not run.

Each gate re-asks at its own end. Answering "yes" once does not run the rest of
the pipeline — if the user wants the whole sequence in one pass, that is
`/work-item <requirement>`, which needs no issue key.
