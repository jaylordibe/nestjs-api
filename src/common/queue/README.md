# Queue infrastructure (BullMQ)

Persistent, Redis-backed background jobs: immediate, delayed and recurring, with
retries, cancellation, rescheduling, bounded retention and structured lifecycle
logging. Shared infrastructure — it contains no domain logic and depends on no
business module.

---

## There is exactly one mechanism

**BullMQ is the only way background work runs in this application.** There is no
in-process scheduler — `@nestjs/schedule` is not a dependency, and adding one
back would reintroduce the failure it was removed for.

| Your job… | Use | Where it is declared |
|---|---|---|
| Runs now but must not block the HTTP response | Immediate job — `enqueue` | `job-registry.ts` |
| Runs once, for one entity, at a computed future instant | Delayed job — `enqueueAt` | `job-registry.ts` |
| Repeats on a fixed cadence or a cron expression | **Recurring job scheduler** | `recurring-schedule-registry.ts` |
| Sweeps *all* rows matching a condition, periodically | A recurring job whose handler runs the one sweep query | `recurring-schedule-registry.ts` |
| Needs retries with backoff on transient failure | Any of the above — the retry policy is per job | `job-registry.ts` |
| Must be cancellable or reschedulable when the entity changes | Delayed job with a deterministic ID | `queue-producer.service.ts` |

### Why no in-process scheduler

An `@Cron` decorator fires once per PROCESS. That is fine on one long-lived
container and wrong everywhere this template now targets:

- **Horizontal autoscaling multiplies it.** Ten API instances means ten copies of
  every nightly sweep, all at once, racing each other over the same rows.
- **It dies with the process.** A scale-in, a redeploy or a crash during the
  scheduled minute means the tick simply never happened, with nothing recording
  that it did not.
- **It cannot be split.** Confining crons to one runtime means either a third
  deployment whose only job is to hold a timer, or a flag that every scheduled
  service has to remember to check.

A BullMQ job scheduler lives in **Redis**. It produces exactly one job per tick
regardless of how many workers exist, survives the replacement of every process
that ever touched it, and lands on the same retry, correlation and lifecycle
machinery as every other job.

### Which runtime does what

```
API runtime                      Worker runtime
QUEUE_WORKER_ENABLED=false       QUEUE_WORKER_ENABLED=true
node dist/main.js                node dist/worker.js
  ├── serves HTTP                  ├── consumes every registered queue
  ├── enqueues jobs                ├── installs + reconciles job schedulers
  ├── never consumes               └── enqueues too (handlers may chain work)
  └── never installs schedulers
```

Producing is never gated. Consuming and scheduler installation are both gated on
`QUEUE_WORKER_ENABLED`, so an API instance can enqueue anything and will act on
nothing. Locally one process does both — there is no autoscaler to duplicate the
work.

### How the gate is enforced

`QueueModule` sets `extraOptions: { manualRegistration: true }` on the BullMQ
root. That is `@nestjs/bullmq`'s own switch: it stops the explorer constructing
a `Worker` per `@Processor` during `onModuleInit`, and nothing consumes until
something calls `BullRegistrar.register()`.

`QueueWorkerRegistrar` is the only caller, and it calls only when
`QUEUE_WORKER_ENABLED` is true. So in the API runtime **no Worker object is ever
constructed** — no Redis connection is opened for one, and there is nothing to
close. Measured on the shipped image: the API holds 1 Redis connection where the
worker holds 4.

Queue PRODUCERS are unaffected. Queue providers come from
`BullModule.registerQueue`, not from the explorer, so an API instance still
enqueues everything.

Processor CLASSES stay registered in both runtimes on purpose: the boot-time
check that every queue has a processor must keep running on the API, which is
the runtime where a queue nobody consumes is hardest to notice. Providing a
class is not the same as running a Worker.

---

## Concepts

**Queue** — a lane with its own worker concurrency, retry defaults and
retention. Declared in `queue-registry.ts`.

**Job name** — `{domain}.{operation}.v{payloadVersion}`, e.g.
`booking.expire.v1`. Declared in `job-registry.ts`, which binds it to a queue.

**Handler** — the only thing a domain module writes. One class implementing
`QueueJobHandler`, marked `@RegisterQueueJobHandler()`.

**Processor** — one per queue, four lines, subclassing `QueueProcessor`. It
validates and dispatches to handlers; you almost never touch it.

**Payload** — a DTO extending `BaseJobPayloadDto`, validated before the handler
runs.

**Recurring schedule** — a repeating job, declared in
`recurring-schedule-registry.ts`.

### What ships out of the box

One queue (`maintenance`) and two recurring jobs:

| Job | Schedule | What it does |
|---|---|---|
| `maintenance.queue-heartbeat.v1` | every 5 minutes | Writes the Redis key behind `GET /api/health/workers`. Carries no domain meaning and must never acquire any. |
| `auth.refresh-token-retention.v1` | `0 0 * * *` UTC | Deletes refresh tokens past their expiry. Data minimisation — an expired row still holds a user id, an IP and a user-agent. |

Only one queue is deliberate, not a stub: only queues with a real producer are
registered, and `QueueJobHandlerRegistry` fails the boot for a queue with no
processor precisely so an aspirational lane cannot sit there looking alive. Add
your queues as you have work for them.

Note where the retention job's handler lives — `src/modules/auth/`, beside the
table it sweeps, not in this folder. Shared queue infrastructure contains no
domain logic; a feature owns its handler and contributes it by registering a
`@RegisterQueueJobHandler()` provider in its own module.

### Redis key namespace

Every key is prefixed with `SERVICE_NAME` (set once in `queue.module.ts`), so a
queue is named for its domain and nothing has to remember to prefix it.

There is **no environment segment** in the name, deliberately: dev, test,
staging and production each point at a physically separate Redis instance
(different ports locally, different hosts deployed), and the e2e harness gives
every jest worker its own logical database. An `{environment}` segment would be
guarding against a shared instance that does not exist.

---

## Adding a job

### 1. Register the job

```ts
// job-registry.ts
export enum JobName {
  BOOKING_EXPIRE_V1 = 'booking.expire.v1',
}

export const JOB_REGISTRATIONS: Record<JobName, JobRegistration> = {
  [JobName.BOOKING_EXPIRE_V1]: {
    queueName: QueueName.BOOKINGS,
    payloadVersion: 1,
    description: 'Expires a booking whose response window has elapsed.',
  },
};
```

`Record<JobName, …>` makes a missing entry a compile error.

### 2. Define the payload

```ts
export class BookingExpirePayloadDto extends BaseJobPayloadDto {
  @IsUUID()
  bookingId!: string;
}
```

Rules, enforced by the processor before your handler runs:

- **Identifiers and execution metadata only — never whole entities.** A
  serialized entity is stale the moment it reaches Redis.
- **No secrets, no personal data.** Finalized jobs are retained for up to a week.
- Timestamps are UTC ISO 8601 strings.
- An unexpected property fails the job permanently (`forbidNonWhitelisted`).

### 3. Write the handler

```ts
@Injectable()
@RegisterQueueJobHandler()
export class BookingExpireHandler
  implements QueueJobHandler<BookingExpirePayloadDto>
{
  readonly jobName = JobName.BOOKING_EXPIRE_V1;
  readonly payloadType = BookingExpirePayloadDto;

  constructor(private readonly bookingsService: BookingsService) {}

  async handle(payload: BookingExpirePayloadDto): Promise<JobOutcome> {
    // 1. RELOAD current state. The payload is identifiers, not a snapshot.
    const booking = await this.bookingsService.findByIdOrNull(payload.bookingId);
    if (!booking) return skippedJob('booking no longer exists');

    // 2. Is the job still applicable?
    if (booking.status !== BookingStatus.PENDING) {
      return skippedJob(`booking is ${booking.status}`);
    }

    // 3. Is this job stale — has a newer schedule superseded it?
    if ((booking.scheduleVersion ?? 0) > (payload.scheduleVersion ?? 0)) {
      return skippedJob('superseded by a newer schedule');
    }

    // 4. Business idempotence, for anything irreversible.
    // 5. Delegate to the domain service — never inline the rules here.
    await this.bookingsService.expire(payload.bookingId, null);
    return completedJob();
  }
}
```

Register it as a provider in its own module. `QueueJobHandlerRegistry` finds it
by decorator at boot and **fails startup** if a registered job has no handler,
or if two handlers claim one job.

### 4. Produce

```ts
// Immediate
await this.queueProducer.enqueue(JobName.BOOKING_EXPIRE_V1, payload);

// Delayed — runs no EARLIER than the instant given
await this.queueProducer.enqueueAt(JobName.BOOKING_EXPIRE_V1, payload, expiresAt);
```

`QueueProducerService` is globally available — no module import needed.
Recurring work is declared rather than called — see below.

---

## Adding a recurring job

Add an entry to `RECURRING_SCHEDULES` in `recurring-schedule-registry.ts`. That
is the whole change — there is no bootstrap class to write.

```ts
{
  schedule: {
    schedulerId: 'maintenance:daily-cleanup:v1',
    cronExpression: '0 3 * * *',
    timeZone: 'Etc/UTC', // mandatory by TYPE for cron schedules
  },
  jobName: JobName.MAINTENANCE_CLEANUP_V1,
  description: 'Purges …',
  buildPayload: () => …,
}
```

`RecurringScheduleInstaller` reconciles this list against Redis **on every
worker boot** — gated on `QUEUE_WORKER_ENABLED`, so the API runtime never writes
here. It upserts everything declared (idempotent by scheduler ID, so N worker
instances starting at once converge on one definition rather than N) **and
removes any scheduler on a registered queue that the list does not declare**.

The gate is not cosmetic. Because reconciliation *deletes* undeclared
schedulers, an API instance doing it would fight the worker pool for the
contents of Redis on any day the two ran different releases.

That second half is why the registry exists. BullMQ job schedulers live in
**Redis, not in the code** — without reconciliation, deleting the code that
created one leaves it firing forever, producing jobs whose name no deployed
release recognises, each failing permanently, on a schedule, with nothing left
anywhere to explain where they come from. Because the registry is authoritative,
**deleting an entry is genuinely enough**.

Reconciliation makes the *running* release authoritative. A rolling worker
replacement can briefly run two releases at once, which will disagree about a
schedule added or removed between them; they converge as soon as the old
revision drains, and the transient jobs fail safely as unknown job names rather
than doing anything.

**A recurring job's handler must be idempotent.** A scheduler tick is
at-least-once, the tick and the work it triggers are not transactional with each
other, and a retry re-runs the same job. If the handler does something
irreversible — sends a message, charges money, calls a third party — it needs
its own already-done check; a schedule is not one.

---

## Adding a queue

1. A `QueueName` member and a `QUEUE_REGISTRATIONS` entry in `queue-registry.ts`.
2. A processor:

```ts
@ProcessesQueue(QueueName.BOOKINGS)
export class BookingsQueueProcessor extends QueueProcessor {
  constructor(context: QueueProcessorContext) {
    super(QueueName.BOOKINGS, context);
  }
}
```

Use `@ProcessesQueue`, never a bare `@Processor`. It carries `autorun: false`,
so a constructed Worker does not start consuming before
`QueueWorkerRegistrar` has set its concurrency and attached its error and
stalled listeners.

3. Add it to `QueueModule`'s providers. Forgetting this **fails the boot**:
   `QueueJobHandlerRegistry` asserts every registered queue has a processor,
   because a queue nothing consumes accepts jobs while every other signal
   (enqueue succeeds, connectivity healthy) stays green.

Only register queues with a real producer. Pre-creating the eventual menu of
queues would spawn an idle Worker each and leave dead weight nobody can tell is
dead.

---

## Timing: what a delayed job does and does not promise

A delayed job's timestamp is the **earliest** instant it becomes eligible. It is
not a guarantee of execution at that instant. Real execution slips with worker
availability, queue depth, Redis latency and deploys.

Work needing tighter timing needs a stated tolerance and monitoring — not a
different queue.

---

## Retries

Defaults: **5 attempts, exponential backoff from 30s**
(`DEFAULT_JOB_RETRY_POLICY`). Precedence, narrowest first:

```
call site → job registration → queue registration → shared default
```

**Retry transient failures only** — network timeouts, provider outages, rate
limits, a database or Redis blip.

**Never retry an expected business outcome.** Entity gone, no longer eligible,
already done, consent withdrawn, schedule superseded — those are `skippedJob()`,
not failures. Retrying them burns five attempts to reach the same answer and
buries the real signal.

For a failure retrying can never fix — an unreadable payload, an unsupported
version — throw `PermanentJobFailureError`. The job goes straight to `failed`.

---

## Idempotency

BullMQ is **at-least-once**. Any job doing something external, financial,
user-visible or irreversible must implement its own business-level idempotence.

A deterministic job ID prevents duplicate **scheduling**. It does not prove the
**operation** has not already run — the job may have completed and been evicted
by retention long before a duplicate arrives.

So the already-happened check belongs to the DOMAIN, not to this layer. The
usual shape is a persisted marker on the row the job acts on (`remindedAt`,
`expiredAt`, a delivery-ledger table keyed by entity + occurrence), and the
ordering rule is always the same: **perform the side effect, then mark it.**
Marking first means a crash between the two silently swallows the work; marking
after means a crash re-runs it, which at-least-once already assumes.

### Deterministic job IDs

```ts
buildDeterministicJobId({ jobName, entityId, scheduleVersion });
// → booking.expire.9f1c0f0e-….2
```

Dot-separated, **not** colon-separated: BullMQ reserves `:` for its own key
namespacing and rejects a custom job ID containing one.

Use one when only a single job of that kind should ever be pending for an
entity. Omit it when several legitimately can be, and BullMQ assigns a unique ID.

---

## Cancelling and rescheduling

`cancelPending(jobName, jobId)` removes a waiting or delayed job. It returns
`false` — rather than throwing — when the job is already gone or already active.

**That race is tolerated by design, not prevented.** A worker can pick a job up
between the decision to cancel and the call landing. This is exactly why
cancellation is never the only guard: the handler re-checks domain state and
skips a job whose reason to exist has gone.

Rescheduling, in order:

1. Update the authoritative domain schedule.
2. Bump its schedule version.
3. → 5. `queueProducer.reschedule(...)` removes the old job, enqueues the
   replacement, and records it.

Steps 1 and 2 are the caller's and must come **first** — the domain row is what
a running handler consults to decide whether it is stale.

Active jobs cannot be force-cancelled, and that is deliberate. A processor
needing it implements cooperative cancellation at its own checkpoints.

---

## Retention

Completed: 1 000 jobs / 24h. Failed: 5 000 jobs / 7 days. Failed jobs outlive
completed ones because they are the ones somebody investigates.

Code constants in `queue-registry.ts`, not env vars — they do not vary by
environment and no operator changes them without a deploy.

---

## Observability

`QueueLifecycleLogger` emits one logfmt line per transition: `scheduled`,
`enqueued`, `started`, `completed`, `retried`, `failed`, `skipped`, `cancelled`,
`rescheduled` — through the app's existing pino logger.

`QueueLifecycleRecord` is a **closed** field list. That is the point: it makes
"never log a job payload" a property of the type rather than a rule in a
document. A handler explains itself through `reason`, which it writes
deliberately.

Workers also log BullMQ `error` and `stalled` events.

### Correlation in a worker

A worker has no HTTP request, so nothing opens a CLS scope for it.
`QueueProcessor` opens one per job and seeds the request ID from the payload's
`correlationId` — so a handler calling `AuditService` still produces a correlated
envelope, and the job's log lines carry the ID of the request that enqueued it.

Only the request ID is seeded. Faking `ip` / `userAgent` / `path` for a
background job would put invented forensic data into `audit_logs`.

---

## Health

| Endpoint | Checks | Fails when |
|---|---|---|
| `GET /api/health/readiness` | database + **queue connectivity** | The API cannot enqueue work |
| `GET /api/health/workers` | **worker heartbeat freshness** | Nothing has consumed a job recently |

Worker liveness is deliberately **off** readiness: an API whose worker is
restarting can still serve every request and queue the work, so it must stay in
the load balancer.

The heartbeat is written by `maintenance.queue-heartbeat.v1`, the one job this
infrastructure ships. It proves the whole loop (scheduler → Redis → worker →
side effect) continuously rather than only when a test runs, and it is the
liveness signal for the worker runtime — a process with no HTTP server has no
other way to answer a healthcheck.

It is also how a failed scheduler installation becomes visible. The heartbeat is
itself one of the recurring schedules, so if `RecurringScheduleInstaller` never
lands its writes, the heartbeat stops and this endpoint goes stale within three
intervals (~15 minutes).

---

## Running a worker

| Runtime | How |
|---|---|
| Combined (local dev) | `yarn start:dev` — `QUEUE_WORKER_ENABLED=true` |
| API-only (deployed API service) | `node dist/main.js` with `QUEUE_WORKER_ENABLED=false` |
| Worker-only (deployed worker pool) | `node dist/worker.js` with `QUEUE_WORKER_ENABLED=true` |

`src/worker.ts` bootstraps the same `AppModule` with no HTTP server. There is
nothing to disarm in it: recurring work is job schedulers in Redis, and the
installer is gated on the same `QUEUE_WORKER_ENABLED` flag, so the schedules
belong to this runtime by construction rather than by a teardown step somebody
had to remember.

### Deploying the two runtimes

Same image, two commands, one variable:

| | API | Worker |
|---|---|---|
| Command | `node dist/main.js` | `node dist/worker.js` |
| `QUEUE_WORKER_ENABLED` | `false` | `true` |
| Health probe | `GET /api/health/readiness` | `GET /api/health/workers` on the API, or the heartbeat key directly |
| Scaling signal | request concurrency | queue depth |

Two deployments of the same image on whatever runs containers — two services,
two Deployments, two Compose services. Give the worker a termination grace
period above `WORKER_SHUTDOWN_TIMEOUT_MILLISECONDS` (25s) so shutdown reports
what it abandoned rather than being SIGKILLed mid-sentence. The full contract is
in `docs/deployment/README.md`.

### Graceful shutdown

On SIGTERM/SIGINT the worker stops accepting new jobs, drains active ones for up
to 25s, closes BullMQ and logs an incomplete shutdown if it runs out of budget.
Jobs still active at that point stay in Redis and are retried once their lock
expires — nothing is silently abandoned.

---

## Redis durability

**Queued jobs are exactly as durable as the Redis they live in.** There is no
in-memory fallback, by design — a fallback would mean jobs silently vanishing on
restart.

The shipped compose stacks run `redis:8.6.2` with `--appendonly yes` (AOF) and a
named volume, so waiting, delayed and retryable jobs survive a restart of the
API, the worker and Redis itself. Any future Redis change must preserve
persistence, adequate storage, backup, availability and monitoring.

---

## Rolling deployments

Job names and payloads are versioned, and a processor rejects a payload version
it does not recognise (permanently — retrying cannot fix it). So during a rolling
deploy an old worker meeting a new producer's payload fails loudly and visibly
rather than half-reading the data.

When changing a payload incompatibly: add `…v2` as a **new** job name, keep the
`…v1` registration and handler until every deployed worker has moved, then
delete v1.

Do not rename the queue namespace with jobs in flight — the old keys become
orphaned rather than migrated.

---

## Testing

`test/queue.e2e-spec.ts` exercises the real BullMQ integration against the
test-stack Redis — nothing is mocked, because a mocked queue proves the mock
works rather than that jobs survive Redis.

Isolation is the harness that already exists: each jest worker owns a logical
Redis database (`test/setup/worker-isolation.ts`) and `truncateAll` flushes it.

`.env.test` sets `QUEUE_WORKER_ENABLED=false` so no other spec runs a live
worker against the database its assertions read — the same reasoning as the cron
teardown in `test/setup/test-app.ts`. The queue spec flips the flag for itself
before compiling its module.

Queue work is asynchronous by definition, so assertions **poll** (`waitUntil`)
rather than sleeping a fixed amount; a fixed sleep is either flaky or slow, and
usually both.
