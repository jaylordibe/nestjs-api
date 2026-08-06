# ADR-0003: Pin the build root and assert the build artifact contract

- **Status:** ACCEPTED
- **Date:** 2026-08-06
- **Owners:** jaylordibe
- **Source:** Staging deploy failure in an adopting project — `Cannot find module '/app/dist/main.js'`; the same defect was then found latent in this baseline
- **Risk:** Critical

## 1. Executive recommendation

`yarn build` can silently change where it writes the application. TypeScript
infers `rootDir` as the common ancestor of every file in the build program, so
adding a single `.ts` file outside `src/` rebases the emit root to the repository
root: `dist/main.js` becomes `dist/src/main.js`, and `CMD ["node", "dist/main.js"]`
cannot resolve. The build exits 0; the container crash-loops.

This baseline was **already broken** when the defect was found downstream. Adding
`scripts/validate-claude-config.ts` (framework 1.0.0) put a second top-level
source directory in scope, and `tsconfig.build.json` excluded only `prisma`.
Verified here: `dist/main.js` absent, `dist/src/main.js` present.

The narrow fix is to add `scripts` to the exclude list. **That is the wrong stopping
point** — it is the same fix already applied twice to the same defect (the
`prisma` exclude exists for exactly this reason, and its in-file comment says so),
and it fails again on the next top-level `.ts` file because it depends on a human
remembering an undocumented trap.

Adopted instead, as one change:

1. **`include: ["src/**/*"]`** — the build compiles `src/` and nothing else, so a
   new top-level file is simply out of scope. This ends the maintenance
   obligation rather than making it louder.
2. **`rootDir: "./src"`** — the backstop. `include` alone is insufficient because
   TypeScript still pulls in any file reached by an import; a stray
   `src → ../scripts/x` import would re-enter the program. Pinned, that fails
   loudly with *"is not under rootDir"*, naming the file.
3. **`tsBuildInfoFile: "./dist/tsconfig.build.tsbuildinfo"`** — required, not
   cosmetic. See §3.
4. **A `postbuild` artifact-contract check** — so a build that cannot boot exits
   non-zero, everywhere, including inside the Docker build stage.

## 2. Why an entrypoint check alone is insufficient

Two independent mechanisms place files in `dist/`:

- `tsc` writes compiled code under `rootDir`;
- `nest build` copies assets under `nest-cli.json`'s `assets[].outDir`, a **fixed
  literal**.

So when the rebase happens, the compiled code moves and the assets do not. In the
downstream incident that produced a *second, independent* boot failure hiding
behind the first: `template-engine.js` moved to `dist/src/common/email/` while its
`.hbs` templates stayed at `dist/common/email/templates`, and the engine resolves
its directory `__dirname`-relative and reads it without a guard during
`onModuleInit`. Repairing only the entrypoint would have produced a second
crash-loop with `ENOENT`.

The check therefore asserts the **loader** as well as its assets, and compares the
asset count against `src/` rather than accepting "at least one".

## 3. The trap inside the fix

Pinning `rootDir` relocates the TypeScript incremental cache. tsc derives the
default `tsBuildInfoFile` from `rootDir` relative to `outDir`, so with
`rootDir: ./src` the cache moves from `dist/tsconfig.build.tsbuildinfo` to the
**project root** — outside the reach of nest-cli's `deleteOutDir`.

Consequence: `deleteOutDir` wipes `dist/`, the surviving root cache reports
nothing affected, and tsc emits nothing while exiting 0. `yarn build` twice in a
row produces assets with no compiled code. This was reproduced downstream before
the fix and is why `tsBuildInfoFile` is named explicitly. The `*.tsbuildinfo`
ignore entries are defence in depth, **not** the fix.

## 4. Options considered

| Option | Verdict |
|---|---|
| **A** — add `scripts` to `exclude` only | Rejected. Symptomatic; the third application of a fix with a 100% recurrence rate |
| **B** — pin `rootDir` + exclude | Rejected alone. Structural, but keeps a blacklist that must grow forever |
| **C** — positive `include` + pin + `tsBuildInfoFile` + postbuild check | **Adopted** |
| **D** — make `CMD` tolerant of either path | Rejected outright. Encodes the bug as supported, leaves the layout non-deterministic, does nothing for the asset split, and ships repository tooling in the runtime image indefinitely |

## 5. Where each assertion lives, and why

The runtime check is **self-contained**: it declares
`CONTAINER_ENTRYPOINT_RELATIVE_PATH` rather than reading the `Dockerfile`.

That is a correction, not an oversight. An earlier revision derived the entrypoint
from the `Dockerfile` `CMD` so a retarget could not leave the guardrail verifying
a file nothing runs — and it **broke every image build**, because `.dockerignore`
excludes the `Dockerfile` and `postbuild` runs inside the Docker build stage where
it is absent. The cross-file assertion moved to `build-config-contract.spec.ts`,
which runs in the repository where the file exists. The anti-drift property is
kept; only the location changed.

Generalise from that: **put each assertion where it can actually execute.**

| Assertion | Home | Why |
|---|---|---|
| Artifact layout after a build | `postbuild` | Must run in the Docker build stage, where only `dist/` and the script exist |
| Config agreement (`rootDir`, `include`, `CMD`, `postbuild` wiring) | `build-config-contract.spec.ts` | Needs repository files the image build cannot see |
| Guardrail behaviour on each omission | `verify-build-artifacts.spec.ts` | Fixture directories; no build required |
| Image really contains what it runs | `test.yml` `docker` job | Only place the built image exists |

## 6. What the guardrail cannot catch, and what covers it

The postbuild check **cannot** detect a reverted `rootDir` pin: with the build
scope still narrow the emitted layout stays correct and the check passes. That is
why `build-config-contract.spec.ts` exists — it asserts the pin, the cache
location, the `include`, the excludes, the `postbuild` wiring, the `CMD` shape and
the `.dockerignore` rules. Both revert cases are proven by deliberate breakage.

## 7, 8, 10, 11, 12 — not applicable

This change has no API/contract surface (7 is folded into §2), no data design,
no threat model beyond release integrity (covered in §1 and §3), no migration,
and no consumer handoff. Numbered gaps are deliberate so section numbers mean
the same thing across every ADR in this repository.

## 9. File-by-file implementation plan

| File | Change |
|---|---|
| `tsconfig.build.json` | `include`, `rootDir`, `tsBuildInfoFile`, plus `scripts` in `exclude` |
| `scripts/verify-build-artifacts.ts` | New. Pure `findBuildArtifactViolations` plus a thin CLI wrapper |
| `scripts/verify-build-artifacts.spec.ts` | New. The correct case as a control, plus every omission |
| `scripts/build-config-contract.spec.ts` | New. Catches a silent revert of the configuration |
| `package.json` | `postbuild` hook; jest `rootDir: "."` + `roots: [src, scripts]` so specs under `scripts/` are collected at all |
| `.github/workflows/test.yml` | The `docker` job now runs the image it builds |
| `.dockerignore`, `.gitignore` | `**/*.tsbuildinfo` / `*.tsbuildinfo` |

## 13. Deliberate non-goals

- Not guarding the template engine's unguarded `readdirSync` — a clearer error
  there would help, but it is a source change in a different module.
- Not adding artifact provenance (signing, registry, digest pinning).
- Not adding `scripts/` to `.dockerignore` — **it must not be added.** `postbuild`
  runs inside the Docker build stage, so `scripts/verify-build-artifacts.ts` is a
  required part of the build context. `build-config-contract.spec.ts` asserts
  this so the trap cannot be walked into.

## 13.1 Adopter note

A project that adopted framework 1.0.0 or 1.1.0 took
`scripts/validate-claude-config.ts` and, unless its `tsconfig.build.json` already
excluded `scripts`, **its build is broken in exactly this way** — silently, until
a container fails to start. See `.claude/CHANGELOG.md` 1.2.0.

## 14. Open decisions and blockers

None. The design was settled downstream against a live failure; this ADR records
its adoption into the baseline.

## 15. Approval

- **Decision:** Approved
- **Approved by:** jaylordibe
- **Date:** 2026-08-06
- **Conditions/accepted risks:**
  - Approved downstream as `infoalanya-v2-api` ADR-0002 against a real staging
    outage, then explicitly instructed to be back-ported to this baseline. The
    design is unchanged; only the exclude entries differ (`prisma`/`scripts`
    directory form here rather than globs).
  - Accepted: the `docker` job step proves the image can resolve its entrypoint
    and that the `COPY` landed. It does not prove the application reaches a
    serving state — that needs service containers and remains the deploy smoke
    test's job.
  - Accepted: adopters on 1.0.0/1.1.0 must apply this by hand. It cannot be
    delivered by copying framework files, because the fix lives in
    project-owned configuration. Mitigated by the one-command check in
    `.claude/CHANGELOG.md` 1.2.0.

## 16. Validation record

`yarn build` from a clean tree, and again with no source change (the idempotency
regression gate for §3) · `yarn lint` · `yarn test` · `yarn claude:validate` ·
deliberate-breakage probes for every omission case and both config reverts ·
`docker build --target runner` with the guardrail observed running inside the
build stage · the entrypoint and assets asserted inside the resulting image · the
real `CMD` run and its module graph confirmed to resolve.
