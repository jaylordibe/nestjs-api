# Deployment contract

This is the **application-side contract**: what the code needs from whatever
runs it. It names no cloud, because the application depends on no cloud.

Everything below is a generic capability. The provider mappings near the end are
**examples**, not requirements — the same image, the same commands and the same
environment variable names deploy to all of them.

```
                        Internet
                           │
                           ▼
                 ┌──────────────────┐
                 │   API runtime    │   node dist/main.js
                 │  (HTTP, scales   │   QUEUE_WORKER_ENABLED=false
                 │   horizontally)  │
                 └────────┬─────────┘
        ┌─────────────────┼─────────────────┬──────────────┐
        ▼                 ▼                 ▼              ▼
  ┌───────────┐   ┌──────────────┐   ┌────────────┐  ┌──────────┐
  │PostgreSQL │   │Redis-        │   │Object      │  │Runtime-  │
  │           │   │compatible    │   │storage     │  │injected  │
  │           │   │              │   │            │  │secrets   │
  └─────▲─────┘   └──────▲───────┘   └─────▲──────┘  └──────────┘
        │                │  enqueue        │
        │                ▼                 │
        │        ┌──────────────────┐      │
        │        │  Worker runtime  │──────┘   node dist/worker.js
        └────────│  (queue depth)   │          QUEUE_WORKER_ENABLED=true
                 └──────────────────┘
                    ├── BullMQ processors
                    └── BullMQ job schedulers   (recurring work lives in Redis)

                 ┌──────────────────┐
                 │  Migration job   │   yarn prisma:deploy
                 │ (runs to exit)   │   run once, before the new API revision
                 └──────────────────┘
```

The application requires exactly these capabilities, and nothing else:

| Capability | Contract |
|---|---|
| HTTP runtime | Runs a Node 24 container, sets `PORT`, routes to `0.0.0.0`, sends `SIGTERM` to stop |
| SQL database | PostgreSQL 18-compatible, reachable over TCP with a connection string |
| Redis-compatible backend | Redis 8-compatible, optional AUTH, optional TLS |
| Object storage | One of: S3-compatible, Google Cloud Storage, Azure Blob — or none (`stub`) |
| Runtime secrets | Injected as environment variables by whatever the platform provides |
| Queue/worker runtime | A second container from the same image running a different command |
| Logging | Collects stdout/stderr |
| Health checks | Can call HTTP endpoints |

---

## 1. Runtime commands

Three commands, one image.

| Runtime | Command | `QUEUE_WORKER_ENABLED` |
|---|---|---|
| **API** | `node dist/main.js` | `false` |
| **Worker** | `node dist/worker.js` | `true` |
| **Migration** | the `migrate` image — schema migration **and** RBAC catalog sync | n/a |

The API and the worker are independently runnable and independently scalable
from the same build. Nothing about the image differs between them.

| | API | Worker |
|---|---|---|
| Serves HTTP | yes | no |
| Enqueues jobs | yes | yes |
| **Consumes** jobs | **never** | yes |
| **Installs recurring schedules** | **never** | yes |
| Health probe | `GET /api/health/readiness` | `GET /api/health/workers` (served by the API, reports on the worker) |
| Scale on | request concurrency | queue depth |

`QUEUE_WORKER_ENABLED` gates job consumption and scheduler reconciliation
together, so there is one switch and no way to get half of it.

**Why the API must not install schedules.** Reconciliation *removes* schedulers
the running release does not declare. If the API did it too, an API instance on
a different release from the worker would delete the worker's schedules while
the worker put them back, indefinitely.

**Why recurring work is not an in-process cron.** A cron decorator fires once
per process, so N API instances run every sweep N times, and a restart during
the scheduled minute skips it with nothing recording that it did not happen. A
BullMQ job scheduler lives in Redis: one job per tick regardless of instance
count, surviving the replacement of every process that touched it.
`@nestjs/schedule` is deliberately not a dependency.

### Local development

One process does everything, because there is no autoscaler to duplicate work:

```bash
docker compose up -d      # PostgreSQL + Redis
yarn prisma:deploy        # or yarn prisma:migrate
yarn start:dev            # QUEUE_WORKER_ENABLED=true, API + worker in one process
```

No cloud account, no credential, no provider SDK configuration. `STORAGE_PROVIDER`
defaults to `stub`, which persists nothing.

---

## 2. Container contract

| Property | Value |
|---|---|
| Base image | `node:24-alpine` |
| Default port | **3000** (`EXPOSE 3000`, documentation only) |
| `$PORT` | **Authoritative.** Set it and the app binds it; a platform that injects its own (8080 is common) simply wins |
| Bind host | `0.0.0.0`, always |
| User | non-root (`app`) for API and worker |
| PID 1 | `tini`, so `SIGTERM` reaches Node instead of being swallowed |
| Logs | JSON to **stdout/stderr** in production, pretty in development. No log files, ever |
| Filesystem | No persistence assumed. Uploads go to object storage; nothing is written to disk |
| Secrets | Never baked into the image — injected at runtime |
| Dependencies | Runtime image carries production dependencies only |
| Build metadata | `GIT_SHA` build arg → `ENV`, surfaced at `GET /api/health/version` |

### Shutdown

`SIGTERM` starts an orderly stop in both runtimes.

- **API** — `enableShutdownHooks()` closes the Nest context: HTTP stops
  accepting, Prisma disconnects and **ends the pg pool**, Redis clients quit,
  BullMQ queues close, telemetry flushes last so the final seconds survive.
- **Worker** — handles the signal explicitly, because Nest's hooks give no way
  to bound how long the close takes or to report what was still running. It
  stops accepting new jobs, drains active ones for up to **25 seconds**, then
  exits. Anything still active stays in Redis and is retried once its lock
  expires; nothing is silently abandoned.

Give the worker a termination grace period **above 25 seconds** so it reports
what it abandoned rather than being `SIGKILL`ed mid-sentence.

### Migrations

Migrations run as their **own container**, to completion, before the new API
revision takes traffic. Never on API startup, never on worker startup — ten
instances booting concurrently would race `migrate deploy` against each other,
and an instance whose migration failed would restart-loop after the previous
release had already stopped.

```bash
docker build --target migrate -t <registry>/<service>-migrate:<sha> .
```

That image runs **two** steps, and both are required. The schema migration alone
is not a complete deploy step: the permission catalog in
`src/common/authorization/` is the source of truth and the database is its
projection, and **the application refuses to boot when the two disagree**. A
release that adds a permission would therefore migrate successfully, report
success, and then crash-loop the API and the worker — after the previous release
had already been replaced. The catalog sync is idempotent, so running it every
time costs nothing when nothing changed.

Deploy order:

1. Build and push the runtime and migrate images from the same commit.
2. Run the migration container. **Stop here if it fails.**
3. Deploy the worker.
4. Deploy the API.

Worker before API, so a new job name has a consumer before anything enqueues it.
Rollback reverses the order, which is why schema changes should be
**expand/contract**: add nullable, backfill, and only drop in a later release. A
migration that adds and removes in one step cannot be rolled back by redeploying
the previous image.

---

## 3. Database contract

PostgreSQL 18-compatible, reachable over TCP. The application knows nothing else
about it — not who operates it, not how it is provisioned.

| Requirement | Detail |
|---|---|
| Connection | A standard `postgresql://` URL in `DATABASE_URL` |
| Extensions | None required beyond a stock installation |
| Migrations | Applied by a separate container, never at startup |
| Pooling | The application pools **in-process**; size it explicitly |

The pool is explicit because the API scales horizontally, and the number that
matters is the product:

```
(API max instances × DATABASE_POOL_MAX)
  + (worker max instances × DATABASE_POOL_MAX)
  + the migration container's pool
  + headroom for an admin session or a backup tool
  < max_connections − the server's superuser reserve
```

Worked example against a server with `max_connections = 400`:

| | instances | × pool | = |
|---|---|---|---|
| API | 10 | 10 | 100 |
| Worker | 3 | 10 | 30 |
| Migration | 1 | 10 | 10 |
| Admin headroom | — | — | 10 |
| | | **total** | **150** |

Raise instance caps **or** the pool, never both without redoing the arithmetic.
If the product exceeds the budget, put a connection pooler in front (PgBouncer,
or whatever the provider offers) rather than shrinking `DATABASE_POOL_MAX` to a
number that starves each instance.

---

## 4. Redis contract

Redis 8-compatible, reachable over TCP. Any implementation that speaks the
protocol works — a container, a managed service, or a compatible alternative.

| Variable | Meaning |
|---|---|
| `REDIS_URL` | `redis://[user:password@]host:port[/db]` or `rediss://…` for TLS |
| `REDIS_TLS_ENABLED` | `true`/`false`. **Must agree with the URL scheme** or boot fails |
| `REDIS_TLS_CA` | Optional PEM CA. Needed only for a private or per-instance CA |

Three properties the application enforces rather than trusts:

- **The scheme and the flag must agree.** Two statements of the same fact that
  can diverge is how a deployment ends up believing traffic is encrypted when it
  is not — the one failure here that produces no error and no symptom.
- **`rejectUnauthorized` is hard-coded `true`** and is not configurable.
  Disabling verification keeps the encryption and discards the only thing that
  proves the far end is the Redis you meant.
- **Every client is built from one function**
  (`src/common/redis/redis-connection.ts`) — the shared app client, the rate
  limiter's storage, and BullMQ — so TLS cannot be configured for one and missed
  for another.

A PEM flattened to one line (`\n` escapes) is normalised automatically, because
every secret-injection mechanism does that.

**Queued jobs are exactly as durable as this Redis.** There is no in-memory
fallback, by design. Use persistence and replication; a flush loses every
waiting, delayed and recurring definition, and schedulers are only rebuilt on
the next worker boot.

---

## 5. Object storage contract

Four adapters behind one interface. **No provider is privileged**, and only the
selected provider's SDK is loaded at runtime — so choosing one costs nothing at
startup for the other three.

| `STORAGE_PROVIDER` | Backend | Authentication |
|---|---|---|
| `stub` (default) | none — persists nothing | none |
| `s3` | AWS S3, Cloudflare R2, DigitalOcean Spaces, MinIO, Ceph | AWS default credential chain — instance profile, task role, IRSA, or `AWS_*` locally |
| `gcs` | Google Cloud Storage | Application Default Credentials — attached service account, or Workload Identity Federation |
| `azure` | Azure Blob Storage | `DefaultAzureCredential` — managed identity, or a CLI login |

**There is no configuration key for a long-lived cloud credential, for any
provider.** No access key, no service-account JSON, no account key, no
connection string. Every adapter authenticates through its platform's keyless
identity chain. That is enforced by a test asserting no such key exists in the
schema.

Objects are **private by default**:

- `STORAGE_PUBLIC_URL_BASE` is unset by default, and `resolvePublicUrl()` then
  returns **null**. Setting it is an explicit operator assertion that the
  bucket is world-readable or CDN-fronted. Nothing in the application makes
  storage public or assumes it is.
- Reads use **short-lived signed URLs**: `createSignedReadUrl()`, clamped to
  `[30s, 1h]` in code whatever `STORAGE_SIGNED_URL_TTL_SECONDS` says.
- **Authorize before signing.** A signed URL is an unrevocable bearer
  credential; the method has no idea who is asking and performs no
  authorization of its own.
- Object names are **server-generated** — a UUID plus a code-chosen
  subdirectory. `buildObjectName` refuses `..`, `//`, leading slashes and
  anything else that could reshape a stored path, so no request value can
  choose where an object lands or reach another tenant's.
- Store the **`storageKey`**, not a URL. A URL embeds the bucket, the provider
  and the access model; a key survives all three changing.

### Cost of shipping four adapters

Only the selected provider's SDK is **loaded**, but all four are **installed**,
so they occupy image space regardless. Measured in the runtime image:

| | Size on disk |
|---|---|
| `@azure/*` (storage-blob + identity) | 60 MB |
| `@aws-sdk/*` (client-s3 + presigner) | 12 MB |
| `@google-cloud/storage` | < 11 MB |
| **storage SDKs total** | **~80 MB of a 659 MB `node_modules`** |

For context, Prisma 7's runtime is ~225 MB and OpenTelemetry ~49 MB in the same
image, so the portability is not what makes it large.

A fork that will only ever use one provider can delete the other three adapter
files, their branches in `file-storage.module.ts`, and their SDKs from
`package.json` — one small commit, nothing outside that folder notices, and it
recovers most of that 80 MB.

### What is actually proven

| Adapter | Coverage |
|---|---|
| `s3` | **Exercised against a real backend.** `test/storage-s3.e2e-spec.ts` runs against MinIO from the test compose stack: upload verified with `HeadObject`, a signed URL that really fetches, an unsigned read that is refused, delete, and non-collision of two identical uploads. This also covers AWS S3, R2, Spaces and Ceph, which speak the same API. |
| `gcs`, `azure` | **Construction only.** The selection switch and the client options are covered; `save`, `delete` and `createSignedReadUrl` have never executed against Google or Azure. Verify against a real bucket before relying on either — particularly `createSignedReadUrl`, which needs `roles/iam.serviceAccountTokenCreator` on GCS and `Storage Blob Data Contributor` on Azure. |
| `stub` | Fully covered; persists nothing. |

Every provider's calls are bounded by `STORAGE_REQUEST_TIMEOUT_MS` (default 15s).
The failure that bounds is a SLOW backend rather than a dead one: an upload
awaiting a hung request keeps its Postgres connection checked out, so a stalled
bucket would otherwise saturate `DATABASE_POOL_MAX` and fail requests that never
touched storage.

---

## 6. Secrets contract

The application reads configuration from **environment variables only**, through
`ConfigService`. It has no dependency on any secret-management SDK and makes no
call to one — injecting secrets is the platform's job, whether that is a
Kubernetes Secret, a task-definition secret reference, a mounted file exported
into the environment, or a plain `.env` file in development.

Never logged. Redaction covers authorization and cookie headers, credential
fields in request bodies, `set-cookie`, and — because this API deliberately
carries a token in a query string on the email-verification link —
secret-bearing **query parameters** are rewritten out of logged URLs before they
reach stdout.

---

## 7. Health contract

| Endpoint | Checks | Use for |
|---|---|---|
| `GET /api/health/liveness` | process only (heap ceiling) | Restart decisions. A database or Redis blip must **not** kill a healthy process |
| `GET /api/health/readiness` | database + queue connectivity | Traffic decisions. An API that cannot enqueue follow-up work is not ready |
| `GET /api/health/workers` | worker heartbeat freshness | Alerting on the worker. **Deliberately off readiness** — a restarting worker must not pull the API out of rotation |
| `GET /api/health/version` | `GIT_SHA` + process start time | Confirming a deploy replaced the running revision |

All are unauthenticated, so a failing check logs the real cause and returns a
fixed string — driver errors quote internal hosts, database users and ports.

These map onto every platform's probe model: a liveness/readiness probe pair
(Kubernetes), a single HTTP health check (most container schedulers), or a
container `HEALTHCHECK`. Nothing about them is provider-specific.

`/api/health/workers` is also the alarm for a failed scheduler installation: the
queue heartbeat is itself one of the recurring schedules, so if installation
never lands, the heartbeat stops and this endpoint goes stale within ~15
minutes.

---

## 8. Environment contract

### Required, both runtimes

| Variable | Notes |
|---|---|
| `NODE_ENV` | `production` |
| `SERVICE_NAME` | lowercase slug; namespaces Redis keys and JWT `iss`/`aud` |
| `DATABASE_URL` | secret |
| `DB_USER`, `DB_PASSWORD`, `DB_HOST`, `DB_PORT`, `DB_NAME` | secret (password) |
| `REDIS_URL` | secret |
| `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` | secret (password) |
| `JWT_SECRET` | secret — 48+ random bytes, unique per environment |
| `API_BASE_URL`, `WEB_BASE_URL` | public hostnames |
| `CORS_ORIGIN` | explicit list; `*` is refused in production |
| `TRUST_PROXY` | `1` behind one proxy hop; `false`/`true` refused in production |

### Runtime-distinguishing

| Variable | API | Worker |
|---|---|---|
| `QUEUE_WORKER_ENABLED` | `false` | `true` |
| `QUEUE_WORKER_CONCURRENCY` | — | `10` |
| `PORT` | platform-injected or 3000 | unused |

### Tuning, with safe defaults

`DATABASE_POOL_MAX` (10), `DATABASE_CONNECTION_TIMEOUT_MS` (5000),
`DATABASE_IDLE_TIMEOUT_MS` (30000), `REDIS_TLS_ENABLED` (false), `REDIS_TLS_CA`,
`THROTTLE_TTL_MS`, `THROTTLE_LIMIT`, `SWAGGER_ENABLED`,
`AUTHORIZATION_GRANTS_CACHE_TTL_SECONDS`, `GIT_SHA`,
`OTEL_EXPORTER_OTLP_ENDPOINT`.

### Optional, only when the matching adapter is selected

| Selected | Requires | Optional |
|---|---|---|
| `STORAGE_PROVIDER=s3` | `STORAGE_S3_BUCKET` | `STORAGE_S3_REGION`, `STORAGE_S3_ENDPOINT`, `STORAGE_S3_FORCE_PATH_STYLE` |
| `STORAGE_PROVIDER=gcs` | `STORAGE_GCS_BUCKET` | `STORAGE_GCS_PROJECT_ID` |
| `STORAGE_PROVIDER=azure` | `STORAGE_AZURE_ACCOUNT_NAME`, `STORAGE_AZURE_CONTAINER` | — |
| `EMAIL_PROVIDER=resend` | `RESEND_API_KEY` (secret), `EMAIL_FROM` | — |
| `SMS_PROVIDER=twilio` | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` (secret), `TWILIO_FROM` | — |

`EMAIL_PROVIDER` and `SMS_PROVIDER` **cannot be `stub` in production** — boot
fails. The stub adapters log the rendered message body, which carries one-time
codes and the verify-email link, so shipping them would put credentials on
stdout through a default nobody chose.

Selecting one provider never requires another's configuration to exist.

---

## 9. Provider mappings — **examples only**

None of these is required, and the application is identical across all of them.

| | API + worker | PostgreSQL | Redis | Object storage |
|---|---|---|---|---|
| **AWS** | ECS/Fargate service + service | RDS | managed Redis | S3 (`s3`) |
| **Google Cloud** | Cloud Run service + worker pool | Cloud SQL | Memorystore | GCS (`gcs`) |
| **Azure** | Container Apps × 2 | Azure Database for PostgreSQL | Azure Cache | Blob (`azure`) |
| **Kubernetes** | two Deployments | operator or managed | operator or managed | any of the three |
| **Docker Compose / VM** | two services | `postgres` container | `redis` container | MinIO (`s3`) or `stub` |

In every case: same image, same three commands, same variable names. What
changes is which values the platform injects and which identity it attaches.

---

## Other deployment material in this repository

- [`../prod/`](../prod/README.md), [`../staging/`](../staging/README.md) — a
  complete **single-VM** Docker Compose deployment behind Caddy. Fully working;
  it predates this contract and runs the API and worker in one container, which
  is correct only where nothing autoscales. Labelled accordingly.
- [`../operations.md`](../operations.md) — an honest inventory of which
  operational controls this template actually enforces versus which it only
  gives you somewhere to put.

## What this document does not cover

Terraform, Pulumi, CDK, Kubernetes manifests, VPC layout, DNS, CI workflow YAML,
monitoring policies, backup drills. Those are infrastructure decisions; the
application-side contract is above, and section 8 is what any of them has to
satisfy.
