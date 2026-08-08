# Operational readiness

**What this document is.** An honest inventory of which operational controls
this template actually implements and which it merely gives you a place to put.
The distinction matters more than the list: a control that exists only as prose
is a control nobody is running, and a checklist that does not say which is which
converts documentation into a false sense of coverage.

Nothing below is claimed as "production-ready" on the strength of being written
down. Where the answer is "you have to do this", it says so.

---

## Legend

| | Meaning |
|---|---|
| ✅ **Implemented** | Code or configuration in this repository enforces it. It runs whether or not anyone remembers it. |
| ⚙️ **Scaffolded** | A script or hook exists, but **nothing schedules or verifies it**. It runs only if an operator wires it up. |
| ❌ **Operator-owned** | Not in this repository at all. Listed so it is a decision rather than an omission. |

---

## Data durability

| Control | Status | Where |
|---|---|---|
| Daily Postgres dump | ⚙️ Scaffolded | `docs/prod/backup.sh` — gzipped, 14-day retention, refuses to keep an empty file |
| Backup **scheduling** | ❌ Operator-owned | The script documents a cron line. Nothing installs it. Until you do, **there are no backups.** |
| Off-site copy | ❌ Operator-owned | Dumps land in `./backups/` on the same host and the same disk as the database. A host loss loses both. |
| Backup **encryption** | ❌ Operator-owned | `gzip`, not `gpg`. The dump contains every user's PII and bcrypt hashes in plaintext-at-rest. |
| Restore **verification** | ❌ Operator-owned | The restore command is documented; nothing exercises it. An unverified backup is a hypothesis, not a recovery plan. |
| Managed PITR | ❌ Operator-owned | On the production checklist in the root `README.md`. Strongly preferred over the dump script — it is the only option here that gives a real RPO. |
| Redis durability | ✅ Implemented | AOF enabled in `docs/prod/docker-compose.yml`. **Queued jobs are exactly as durable as the Redis they live in**, and there is deliberately no in-memory fallback. |

### RPO / RTO

This template **does not set** an RPO or RTO, because neither is a property of
code — both are consequences of infrastructure you choose.

What the shipped configuration implies, if you install the cron line and change
nothing else:

- **RPO ≈ 24 hours.** One dump per day, overwritten in place. Everything since
  the last dump is lost.
- **RTO = unbounded.** No restore has been rehearsed, and the only copy is on
  the host that failed.

Both are unacceptable for anything holding real user data. Managed Postgres with
PITR moves RPO to minutes and RTO to a documented restore; that is the intended
path, and the dump script is a stopgap for a single-box deployment.

---

## Secrets

| Control | Status | Where |
|---|---|---|
| Boot-time validation | ✅ Implemented | `src/config/env.validation.ts` — Joi refuses to start on a missing or malformed value |
| Template-default rejection | ✅ Implemented | The `JWT_SECRET` that shipped in earlier versions is explicitly `.invalid()`, so a checkout cannot silently deploy with it |
| Production-only strictness | ✅ Implemented | `TRUST_PROXY` refuses `"true"`/`"false"` and `CORS_ORIGIN` refuses `*` when `NODE_ENV=production` |
| Secrets **at rest** | ❌ Operator-owned | Deploys read a plaintext `.env` on the server. A secret manager is on the production checklist and is not wired up. |
| **Rotation** | ❌ Operator-owned | No rotation mechanism, schedule, or dual-key window exists. Rotating `JWT_SECRET` invalidates every outstanding access token immediately — which is correct behaviour, but it is a hard cutover, not a rolling one. |

---

## Retention and erasure

| Control | Status | Where |
|---|---|---|
| GDPR erasure endpoint | ✅ Implemented | `POST /users/me/gdpr-erase` — anonymises PII, requires re-authentication, revokes every session, and **soft-deletes any business the subject solely owned**. Erasure answers a legal obligation, so it is never refused for a commercial relationship; `DELETE /users/me` is refused in that case instead (`LAST_OWNER_PROTECTED`). |
| Data export | ✅ Implemented | `GET /users/me/export` |
| Audit-log **retention** | ❌ Operator-owned | `audit_logs` grows without bound. It holds IPs, user agents, and (behind Cloudflare) geolocation, so it is itself personal data with a retention obligation. |
| Soft-delete **hard purge** | ⚙️ Scaffolded | `src/common/scheduled-jobs/example-retention-sweep.service.ts` is a worked pattern, not an installed policy. Soft-deleted users are retained indefinitely by default. |
| Refresh-token purge | ✅ Implemented | `RefreshTokenService.purgeExpired` — expired rows carry a user id and a device fingerprint, so they are deleted rather than kept |
| Membership history | ✅ **By design, never purged** | A `BusinessMembership` moves to `left` rather than being deleted. That is what lets `@@unique([businessId, userId])` be unconditional. Erasure anonymises the *user*, which is what carries the personal data. |

**Note the asymmetry.** Erasure is implemented; retention is not. A subject
access request can be answered today; "delete everything older than N days"
cannot, without work.

---

## Database and migrations

| Control | Status | Where |
|---|---|---|
| Migration-vs-data safety gate | ✅ Implemented | `.github/workflows/test.yml` → `migration-safety`. Applies the released migrations, seeds real rows, asserts the DB is non-empty, then applies the proposed migrations **on top of populated data**. |
| Expand/contract proof | ✅ Implemented | Same job boots the **released** build against the **new** schema. Production runs old code against the new schema for the whole swap window, and nothing else tests that. |
| Template re-baseline escape hatch | ✅ Implemented | When a released migration is edited or deleted, the job detects it, skips the two comparisons that cannot apply, prints a loud warning, and instead proves the new baseline applies to an empty database and seeds. |
| Connection-pool sizing | ❌ Operator-owned | Prisma's default pool is `num_cpus * 2 + 1`. With an API and a worker on one box, both hold pools against the same Postgres — size `max_connections` accordingly or expect saturation under load rather than a clear error. |

### Expand/contract policy

Deploys run `migrate` **before** `up -d`, so the old container serves traffic
against the new schema for the length of the build-and-swap. A migration must
therefore be backwards-compatible with the code currently running.

In practice: add columns nullable, backfill separately, and only tighten or drop
in a **later** release once no running build reads them. The CI job above is what
enforces this rather than the honour system — it will fail a `DROP COLUMN` that
the released build still selects.

---

## Background work

| Control | Status | Where |
|---|---|---|
| Worker liveness | ✅ Implemented | `GET /api/health/workers`, deliberately **off** readiness so a stopped worker cannot pull the API out of rotation — which also means nothing else will tell you it died. **Monitor this endpoint.** |
| Retry policy | ✅ Implemented | Per-job in `job-registry.ts`; bounded attempts with backoff |
| Duplicate delivery | ✅ Implemented | Handlers must tolerate it; deterministic job ids collapse duplicate schedules |
| Correlation | ✅ Implemented | `correlationId` flows request → job → worker log lines |
| Operator recovery | ✅ Implemented | `/api/queues` — inspect, retry, cancel. Payloads gated behind `readPayload QueueJob`. |
| Queue **backpressure** | ❌ Operator-owned | `QUEUE_WORKER_CONCURRENCY` is the only lever, and nothing alerts on depth. A queue growing faster than it drains is invisible until Redis fills. Alert on `GET /api/queues` depth. |

---

## Load, soak, and isolation testing

| Control | Status |
|---|---|
| Tenant-isolation regression tests | ✅ Implemented — cross-tenant reads, forged path parameters, suspended and ended memberships, and mis-scoped roles all have e2e coverage |
| Authorization regression tests | ✅ Implemented — every role boundary in the catalog is asserted against a real endpoint |
| Concurrency tests | ✅ Implemented — simultaneous owner demotion, invitation acceptance, and refresh-token exchange |
| **Load / soak testing** | ❌ Operator-owned — no harness, no baseline, no thresholds. Nothing here tells you the shape of the system under sustained traffic. |

---

## Incident response

❌ **Operator-owned, entirely.** No runbook, on-call rota, severity ladder, or
escalation path ships here.

What the template does give an investigator:

- `audit_logs` with a server-vouched request envelope (request id, IP, user
  agent, parsed device, method, path) on every privileged action.
- A single request id shared by the response header, the application logs, and
  the audit row — see the correlation contract in the root `README.md`.
- Replay detection on refresh tokens, recorded as
  `auth.refresh_token.replay_detected` with the family id and no token material.
- OpenTelemetry traces and metrics when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.

**Error tracking is not wired up.** Sentry/Datadog/Axiom is on the production
checklist and is not included.

---

## Rollback

⚙️ **Partially scaffolded.**

The deploy stops the old container and starts the new one, waiting on its
healthcheck; a failed healthcheck fails the workflow. But the image is built
**on the server** rather than in CI, there is no registry, no immutable tag, and
therefore **no previous image to roll back to** — recovery means redeploying an
earlier commit and rebuilding.

Immutable images, commit-SHA tags, digest-pinned deploys, SBOM generation,
signing, and automated rollback to the previous healthy digest are deliberately
**out of scope** for this template and require a registry decision. See the
deployment docs.

Database rollback is separate and harder: migrations are forward-only, so a
schema change is reversed by restoring a backup, not by re-running a deploy.
That is another reason the backup gaps at the top of this document matter.
