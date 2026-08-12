import { INestApplication, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import request from 'supertest';
import { App } from 'supertest/types';
import { QueueHeartbeatPayloadDto } from '../src/common/queue/heartbeat/queue-heartbeat-payload.dto';
import { QueueHeartbeatHandler } from '../src/common/queue/heartbeat/queue-heartbeat.handler';
import { RegisterQueueJobHandler } from '../src/common/queue/queue-job-handler';
import type { JobOutcome } from '../src/common/queue/queue-job-outcome';
import { JobName } from '../src/common/queue/job-registry';
import { MaintenanceQueueProcessor } from '../src/common/queue/processors/maintenance-queue.processor';
import { QueueProducerService } from '../src/common/queue/queue-producer.service';
import { QueueName } from '../src/common/queue/queue-registry';
import { RECURRING_SCHEDULES } from '../src/common/queue/recurring-schedule-registry';
import { RecurringScheduleInstaller } from '../src/common/queue/recurring-schedule.installer';
import { buildQueueHeartbeatRedisKey } from '../src/common/queue/heartbeat/queue-heartbeat.constants';
import { RedisService } from '../src/common/redis/redis.service';
import { buildDeterministicJobId } from '../src/common/util/queue-job-id.util';
import { truncateAll } from './setup/db';
import { createTestApp } from './setup/test-app';

// Exercises the real BullMQ integration against the test-stack Redis — nothing
// about the queue is mocked, deliberately: a mocked queue proves the mock
// works, not that jobs survive Redis. Isolation comes from the harness that
// already exists: each jest worker owns a logical Redis
// database (test/setup/worker-isolation.ts) and `truncateAll` flushes it, so
// queue state never leaks between specs or between workers.
//
// `.env.test` ships QUEUE_WORKER_ENABLED=false so no OTHER spec runs a live
// worker against the database its assertions read — the same reasoning as the
// cron teardown in test/setup/test-app.ts. This spec is the exception and flips
// the flag itself, before createTestApp compiles the module (the config factory
// re-runs per compiled AppModule, so the value is picked up).

const HEARTBEAT_JOB = JobName.MAINTENANCE_QUEUE_HEARTBEAT_V1;
const ONE_HOUR_MS = 60 * 60 * 1000;

function heartbeatPayload(
  overrides: Partial<QueueHeartbeatPayloadDto> = {},
): QueueHeartbeatPayloadDto {
  return Object.assign(new QueueHeartbeatPayloadDto(), {
    payloadVersion: 1,
    ...overrides,
  });
}

// Wraps the real handler to capture the CLS id the processor seeded before
// calling it. That id is what `AuditService` reads via `cls.getId()`, so this
// is the only way to prove worker-originated work is actually correlated back
// to the request that enqueued it — a property that failed silently once
// already (seeding a `'requestId'` string key instead of the CLS_ID symbol
// wrote to a different slot and read back as undefined).
@Injectable()
@RegisterQueueJobHandler()
class CorrelationRecordingHeartbeatHandler extends QueueHeartbeatHandler {
  readonly observedCorrelationIds: string[] = [];

  constructor(
    redisService: RedisService,
    configService: ConfigService,
    private readonly clsService: ClsService,
  ) {
    super(redisService, configService);
  }

  handle(payload: QueueHeartbeatPayloadDto): Promise<JobOutcome> {
    this.observedCorrelationIds.push(this.clsService.getId());
    return super.handle(payload);
  }
}

// Queue work is asynchronous by definition, so assertions poll rather than
// sleep a fixed amount — a fixed sleep is either flaky or slow, and usually
// both.
async function waitUntil(
  condition: () => Promise<boolean>,
  description: string,
  timeoutMilliseconds = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for: ${description}`);
}

describe('Queue infrastructure (e2e)', () => {
  const originalWorkerEnabled = process.env.QUEUE_WORKER_ENABLED;

  afterAll(() => {
    process.env.QUEUE_WORKER_ENABLED = originalWorkerEnabled;
  });

  // Declared FIRST so its app is created and closed before the worker-enabled
  // app exists — two apps consuming the same queue would race for the jobs this
  // block asserts stay untouched.
  //
  // This block IS the production API runtime contract: QUEUE_WORKER_ENABLED=false
  // must produce a process that enqueues and does nothing else. Both halves are
  // asserted, because each fails silently on its own — a consuming API looks
  // fine until it duplicates a worker's work, and an API that installs job
  // schedulers looks fine until a second release starts deleting the first's.
  describe('with the worker disabled (an API-only instance)', () => {
    let app: INestApplication<App>;

    beforeAll(async () => {
      process.env.QUEUE_WORKER_ENABLED = 'false';
      app = await createTestApp();
      // Flushed BEFORE the assertion window opens, and deliberately NOT after
      // the app is exercised: `truncateAll` issues a `flushdb`, so flushing
      // after boot would erase whatever an ungated installer had just written
      // and let the "installs no schedulers" assertion below pass for the wrong
      // reason. Anything present at assertion time was necessarily written
      // after this point.
      await truncateAll(app);
    });
    afterAll(async () => {
      await app.close();
    });

    // A STRONGER claim than "the worker is not running": with
    // `manualRegistration: true` and no `BullRegistrar.register()` call, no
    // Worker object exists at all, so this process opens no Redis connection
    // for one and has nothing to close. @nestjs/bullmq's WorkerHost throws on
    // access before registration, which is exactly the evidence wanted here.
    it('constructs no worker at all', () => {
      expect(() => app.get(MaintenanceQueueProcessor).worker).toThrow(
        /has not yet been initialized/,
      );
    });

    // Reconciliation REMOVES schedulers the running release does not declare,
    // so an API instance doing it would fight the worker pool for the contents
    // of Redis whenever the two ran different releases. `truncateAll` above
    // flushed the logical database, so anything present here was installed by
    // this app's own bootstrap.
    it('installs no recurring job schedulers — the worker runtime owns them', async () => {
      const producer = app.get(QueueProducerService);

      // The GATED entry point, invoked deliberately — not `reconcileNow()`,
      // which is the ungated test seam and would install the schedules this
      // asserts are absent. Calling it a second time here means the assertion
      // is about the gate rather than about whether the fire-and-forget
      // bootstrap hook happened to have run yet.
      app.get(RecurringScheduleInstaller).onApplicationBootstrap();
      // Generous enough that an ungated installer would certainly have written.
      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(
        await producer.listRecurringScheduleIds(QueueName.MAINTENANCE),
      ).toEqual([]);
    });

    it('still enqueues — the job simply waits for a consumer', async () => {
      const producer = app.get(QueueProducerService);
      const jobId = await producer.enqueue(HEARTBEAT_JOB, heartbeatPayload());

      const queue = app.get<Queue>(getQueueToken(QueueName.MAINTENANCE));
      // Long enough that a running worker would certainly have taken it.
      await new Promise((resolve) => setTimeout(resolve, 750));
      // Asserted on THIS job's state rather than a queue-wide count, because
      // the claim is "the job I enqueued was not consumed" — which stays exact
      // regardless of what else happens to be on the queue.
      expect(await (await queue.getJob(jobId))?.getState()).toBe('waiting');

      // And the side effect definitively did not happen.
      const serviceName = app
        .get(ConfigService)
        .getOrThrow<string>('serviceName');
      expect(
        await app
          .get(RedisService)
          .client.get(buildQueueHeartbeatRedisKey(serviceName)),
      ).toBeNull();
    });
  });

  describe('with the worker enabled', () => {
    let app: INestApplication<App>;
    let producer: QueueProducerService;
    let queue: Queue;
    let processor: MaintenanceQueueProcessor;
    let heartbeatHandler: CorrelationRecordingHeartbeatHandler;
    let heartbeatKey: string;

    beforeAll(async () => {
      process.env.QUEUE_WORKER_ENABLED = 'true';
      app = await createTestApp((builder) =>
        builder
          .overrideProvider(QueueHeartbeatHandler)
          .useClass(CorrelationRecordingHeartbeatHandler),
      );
      producer = app.get(QueueProducerService);
      queue = app.get<Queue>(getQueueToken(QueueName.MAINTENANCE));
      processor = app.get(MaintenanceQueueProcessor);
      heartbeatHandler = app.get(QueueHeartbeatHandler);
      heartbeatKey = buildQueueHeartbeatRedisKey(
        app.get(ConfigService).getOrThrow<string>('serviceName'),
      );
    });
    beforeEach(async () => {
      // `truncateAll` flushes the whole logical Redis database, which includes
      // BullMQ's keys. Draining the worker first is load-bearing: a job that is
      // mid-flight when its keys vanish fails with "Missing key for job N.
      // moveToFinished" — noise at best, and a source of cross-test flakiness
      // at worst. pause() waits for active jobs; resume() puts it straight back.
      await processor.worker.pause();
      await truncateAll(app);
      processor.worker.resume();
      heartbeatHandler.observedCorrelationIds.length = 0;
    });
    afterAll(async () => {
      await app.close();
    });

    const readHeartbeat = (): Promise<string | null> =>
      app.get(RedisService).client.get(heartbeatKey);

    describe('immediate jobs', () => {
      it('runs an enqueued job and performs its side effect', async () => {
        await producer.enqueue(HEARTBEAT_JOB, heartbeatPayload());
        await waitUntil(
          async () => (await readHeartbeat()) !== null,
          'the heartbeat key to be written',
        );
      });

      it('records a completed outcome', async () => {
        const jobId = await producer.enqueue(HEARTBEAT_JOB, heartbeatPayload());
        await waitUntil(
          async () => (await queue.getJob(jobId))?.finishedOn !== undefined,
          'the job to finish',
        );
        expect((await queue.getJob(jobId))?.returnvalue).toEqual({
          status: 'completed',
        });
      });
    });

    describe('correlation', () => {
      it('runs the handler inside a CLS scope carrying the enqueuing request ID', async () => {
        // This is the ID AuditService stamps into `metadata.request.requestId`,
        // so without it a worker-written audit row cannot be traced back to the
        // HTTP call that caused it.
        const correlationId = 'request-that-enqueued-the-job';
        await producer.enqueue(
          HEARTBEAT_JOB,
          heartbeatPayload({ correlationId }),
        );

        await waitUntil(
          async () => (await readHeartbeat()) !== null,
          'the job to run',
        );
        expect(heartbeatHandler.observedCorrelationIds).toEqual([
          correlationId,
        ]);
      });

      it('falls back to the job ID when nothing supplied a correlation ID', async () => {
        const jobId = await producer.enqueue(HEARTBEAT_JOB, heartbeatPayload());

        await waitUntil(
          async () => (await readHeartbeat()) !== null,
          'the job to run',
        );
        expect(heartbeatHandler.observedCorrelationIds).toEqual([
          `job.${jobId}`,
        ]);
      });
    });

    describe('delayed jobs', () => {
      it('holds the job until its instant and keeps the ABSOLUTE time in the payload', async () => {
        const runAt = new Date(Date.now() + ONE_HOUR_MS);
        const jobId = await producer.enqueueAt(
          HEARTBEAT_JOB,
          heartbeatPayload(),
          runAt,
        );

        const job = await queue.getJob(jobId);
        expect(await job?.getState()).toBe('delayed');
        // BullMQ stores only a relative delay; the absolute instant has to
        // survive in the payload or a worker can never tell whether the
        // schedule it was created from still stands.
        expect((job?.data as QueueHeartbeatPayloadDto).scheduledAt).toBe(
          runAt.toISOString(),
        );
        expect(job?.opts.delay).toBeGreaterThan(ONE_HOUR_MS - 60_000);
      });

      it('clamps a past instant to no delay rather than a negative one', async () => {
        const jobId = await producer.enqueueAt(
          HEARTBEAT_JOB,
          heartbeatPayload(),
          new Date(Date.now() - ONE_HOUR_MS),
        );
        expect((await queue.getJob(jobId))?.opts.delay).toBe(0);
      });
    });

    describe('recurring schedule reconciliation', () => {
      const declaredSchedulerIds = RECURRING_SCHEDULES.map(
        (registration) => registration.schedule.schedulerId,
      );

      it('installs every schedule the registry declares', async () => {
        await app.get(RecurringScheduleInstaller).reconcileNow();

        const installedSchedulerIds = await producer.listRecurringScheduleIds(
          QueueName.MAINTENANCE,
        );
        for (const schedulerId of declaredSchedulerIds) {
          expect(installedSchedulerIds).toContain(schedulerId);
        }
      });

      // The reason the registry exists. BullMQ schedulers live in REDIS, so
      // deleting the code that created one leaves it firing forever, producing
      // jobs whose name no release recognises. Reconciliation is what makes
      // deleting a registry entry actually stop the job.
      it('removes a scheduler the registry no longer declares', async () => {
        const orphanSchedulerId = 'maintenance:decommissioned-job:v1';
        await producer.upsertRecurringSchedule(
          HEARTBEAT_JOB,
          heartbeatPayload(),
          { schedulerId: orphanSchedulerId, everyMilliseconds: 60_000 },
        );
        expect(
          await producer.listRecurringScheduleIds(QueueName.MAINTENANCE),
        ).toContain(orphanSchedulerId);

        await app.get(RecurringScheduleInstaller).reconcileNow();

        const installedSchedulerIds = await producer.listRecurringScheduleIds(
          QueueName.MAINTENANCE,
        );
        expect(installedSchedulerIds).not.toContain(orphanSchedulerId);
        // And it did not take the declared ones with it.
        for (const schedulerId of declaredSchedulerIds) {
          expect(installedSchedulerIds).toContain(schedulerId);
        }
      });

      it('is idempotent — reconciling twice changes nothing', async () => {
        const installer = app.get(RecurringScheduleInstaller);
        await installer.reconcileNow();
        const afterFirstRun = await producer.listRecurringScheduleIds(
          QueueName.MAINTENANCE,
        );
        await installer.reconcileNow();
        const afterSecondRun = await producer.listRecurringScheduleIds(
          QueueName.MAINTENANCE,
        );
        expect(afterSecondRun.sort()).toEqual(afterFirstRun.sort());
      });
    });

    describe('recurring job schedulers', () => {
      it('updates rather than duplicates on repeated upsert', async () => {
        const schedulerId = 'maintenance:heartbeat-spec:v1';
        const schedule = { schedulerId, everyMilliseconds: 60_000 };

        await producer.upsertRecurringSchedule(
          HEARTBEAT_JOB,
          heartbeatPayload(),
          schedule,
        );
        await producer.upsertRecurringSchedule(
          HEARTBEAT_JOB,
          heartbeatPayload(),
          schedule,
        );

        const schedulers = await queue.getJobSchedulers();
        expect(
          schedulers.filter((scheduler) => scheduler.key === schedulerId),
        ).toHaveLength(1);
      });

      it('pins a cron schedule to its explicit IANA timezone', async () => {
        const schedulerId = 'maintenance:cron-spec:v1';
        await producer.upsertRecurringSchedule(
          HEARTBEAT_JOB,
          heartbeatPayload(),
          {
            schedulerId,
            cronExpression: '30 17 * * *',
            timeZone: 'Europe/Berlin',
          },
        );

        const scheduler = (await queue.getJobSchedulers()).find(
          (candidate) => candidate.key === schedulerId,
        );
        // Without this the expression would follow the container clock, which
        // is UTC in every deployed environment.
        expect(scheduler?.tz).toBe('Europe/Berlin');
        expect(scheduler?.pattern).toBe('30 17 * * *');
      });
    });

    describe('payload validation', () => {
      const waitForFailure = async (jobId: string) => {
        await waitUntil(
          async () => (await queue.getJob(jobId))?.finishedOn !== undefined,
          'the job to fail',
        );
        return queue.getJob(jobId);
      };

      it('fails an unsupported payload version permanently, without retrying', async () => {
        // Enqueued through the raw queue with 3 attempts precisely so that a
        // retry, if one happened, would be visible.
        const job = await queue.add(
          HEARTBEAT_JOB,
          { payloadVersion: 99 },
          { attempts: 3, backoff: { type: 'fixed', delay: 10 } },
        );

        const failedJob = await waitForFailure(job.id!);
        expect(failedJob?.failedReason).toContain(
          'Unsupported payload version',
        );
        // The whole point: one attempt, not three. Retrying cannot make an
        // unreadable payload readable.
        expect(failedJob?.attemptsMade).toBe(1);
      });

      it('fails an unknown job name permanently', async () => {
        const job = await queue.add(
          'maintenance.not-a-real-job.v1',
          { payloadVersion: 1 },
          { attempts: 3, backoff: { type: 'fixed', delay: 10 } },
        );

        const failedJob = await waitForFailure(job.id!);
        expect(failedJob?.failedReason).toContain('Unknown job name');
        expect(failedJob?.attemptsMade).toBe(1);
      });

      it('rejects an unexpected payload property without echoing its value', async () => {
        const job = await queue.add(
          HEARTBEAT_JOB,
          { payloadVersion: 1, smuggledSecret: 'super-secret-token' },
          { attempts: 2, backoff: { type: 'fixed', delay: 10 } },
        );

        const failedJob = await waitForFailure(job.id!);
        expect(failedJob?.failedReason).toContain('Invalid payload');
        expect(failedJob?.failedReason).toContain('smuggledSecret');
        // Failed jobs are retained for a week and the reason is logged, so the
        // offending VALUE must never appear in it.
        expect(failedJob?.failedReason).not.toContain('super-secret-token');
      });
    });

    describe('retry policy', () => {
      it('applies the registered policy to an enqueued job', async () => {
        const jobId = await producer.enqueueAt(
          HEARTBEAT_JOB,
          heartbeatPayload(),
          new Date(Date.now() + ONE_HOUR_MS),
        );
        const job = await queue.getJob(jobId);
        // The heartbeat registers attempts: 1 — a stale beat is superseded by
        // the next one, so retrying it is noise.
        expect(job?.opts.attempts).toBe(1);
        // Retention is always bounded, never per-call-site.
        expect(job?.opts.removeOnComplete).toEqual(
          expect.objectContaining({ count: expect.any(Number) as unknown }),
        );
      });

      it('lets a call site override the registered policy', async () => {
        const jobId = await producer.enqueueAt(
          HEARTBEAT_JOB,
          heartbeatPayload(),
          new Date(Date.now() + ONE_HOUR_MS),
          {
            retryPolicy: {
              attempts: 4,
              backoffStrategy: 'exponential',
              initialBackoffMilliseconds: 1_000,
            },
          },
        );
        const job = await queue.getJob(jobId);
        expect(job?.opts.attempts).toBe(4);
        expect(job?.opts.backoff).toEqual({
          type: 'exponential',
          delay: 1_000,
        });
      });
    });

    describe('deterministic job IDs', () => {
      it('collapses a duplicate pending schedule into one job', async () => {
        // BullMQ rejects a custom job ID containing ':', so the builder emits
        // dot-separated segments — asserted here against the real queue, which
        // is the only place a colon-separated ID would actually blow up.
        const jobId = buildDeterministicJobId({
          jobName: HEARTBEAT_JOB,
          entityId: 'entity-under-test',
          scheduleVersion: 1,
        });
        expect(jobId).not.toContain(':');
        const runAt = new Date(Date.now() + ONE_HOUR_MS);

        await producer.enqueueAt(HEARTBEAT_JOB, heartbeatPayload(), runAt, {
          jobId,
        });
        await producer.enqueueAt(HEARTBEAT_JOB, heartbeatPayload(), runAt, {
          jobId,
        });

        expect(await queue.getDelayedCount()).toBe(1);
      });
    });

    describe('cancellation', () => {
      it('removes a pending job', async () => {
        const jobId = await producer.enqueueAt(
          HEARTBEAT_JOB,
          heartbeatPayload(),
          new Date(Date.now() + ONE_HOUR_MS),
        );

        expect(await producer.cancelPending(HEARTBEAT_JOB, jobId)).toBe(true);
        expect(await queue.getDelayedCount()).toBe(0);
      });

      it('reports false for a job that is already gone', async () => {
        expect(await producer.cancelPending(HEARTBEAT_JOB, 'no-such-job')).toBe(
          false,
        );
      });

      // Retention keeps completed jobs for a day, so `getJob` still finds them
      // and BullMQ's `remove()` would happily delete one. Cancelling a job that
      // ALREADY RAN must report false — otherwise a reschedule reports the old
      // job as superseded when its side effect has already reached the customer,
      // and deletes the completed record that proves it.
      it('refuses to cancel a job that already completed', async () => {
        const jobId = await producer.enqueue(HEARTBEAT_JOB, heartbeatPayload());
        await waitUntil(
          async () => (await queue.getJob(jobId))?.finishedOn !== undefined,
          'the job to complete',
        );

        expect(await producer.cancelPending(HEARTBEAT_JOB, jobId)).toBe(false);
        // And the completed record survives.
        expect(await queue.getJob(jobId)).toBeDefined();
      });
    });

    describe('rescheduling', () => {
      it('supersedes the pending job with one at the new instant', async () => {
        const previousJobId = buildDeterministicJobId({
          jobName: HEARTBEAT_JOB,
          entityId: 'entity-under-test',
          scheduleVersion: 1,
        });
        const replacementJobId = buildDeterministicJobId({
          jobName: HEARTBEAT_JOB,
          entityId: 'entity-under-test',
          scheduleVersion: 2,
        });

        await producer.enqueueAt(
          HEARTBEAT_JOB,
          heartbeatPayload({ scheduleVersion: 1 }),
          new Date(Date.now() + ONE_HOUR_MS),
          { jobId: previousJobId },
        );

        const newRunAt = new Date(Date.now() + 2 * ONE_HOUR_MS);
        const result = await producer.reschedule(
          HEARTBEAT_JOB,
          heartbeatPayload({ scheduleVersion: 2 }),
          newRunAt,
          { previousJobId, jobId: replacementJobId },
        );

        expect(result.previousJobRemoved).toBe(true);
        expect(result.jobId).toBe(replacementJobId);
        expect(await queue.getJob(previousJobId)).toBeUndefined();

        const replacement = await queue.getJob(replacementJobId);
        const replacementPayload =
          replacement?.data as QueueHeartbeatPayloadDto;
        expect(replacementPayload.scheduleVersion).toBe(2);
        expect(replacementPayload.scheduledAt).toBe(newRunAt.toISOString());
        expect(await queue.getDelayedCount()).toBe(1);
      });

      // Enqueue-first ordering makes an unchanged deterministic ID actively
      // destructive: the replacement would collapse onto the superseded job and
      // the cancel that follows would delete it, leaving nothing scheduled.
      it('refuses to reschedule onto the same job ID', async () => {
        const jobId = buildDeterministicJobId({
          jobName: HEARTBEAT_JOB,
          entityId: 'entity-under-test',
          scheduleVersion: 1,
        });
        await producer.enqueueAt(
          HEARTBEAT_JOB,
          heartbeatPayload({ scheduleVersion: 1 }),
          new Date(Date.now() + ONE_HOUR_MS),
          { jobId },
        );

        await expect(
          producer.reschedule(
            HEARTBEAT_JOB,
            heartbeatPayload({ scheduleVersion: 1 }),
            new Date(Date.now() + 2 * ONE_HOUR_MS),
            { previousJobId: jobId, jobId },
          ),
        ).rejects.toThrow(/Bump the schedule version/);

        // The originally scheduled job is untouched.
        expect(await queue.getDelayedCount()).toBe(1);
      });
    });

    describe('stale jobs', () => {
      it('skips a superseded job instead of executing it', async () => {
        // Scheduled far enough in the past that the handler's staleness rule
        // fires. The delay clamps to 0, so the worker picks it up immediately —
        // this is exactly the shape of a delayed job that outlived the schedule
        // that created it.
        const jobId = await producer.enqueueAt(
          HEARTBEAT_JOB,
          heartbeatPayload(),
          new Date(Date.now() - ONE_HOUR_MS),
        );

        await waitUntil(
          async () => (await queue.getJob(jobId))?.finishedOn !== undefined,
          'the stale job to finish',
        );

        const job = await queue.getJob(jobId);
        // Skipped, NOT failed — nothing went wrong, the job just stopped being
        // worth doing. A failure here would burn retries and page somebody.
        expect(job?.returnvalue).toEqual({
          status: 'skipped',
          reason: expect.stringContaining('superseded') as unknown,
        });
        expect(job?.failedReason).toBeFalsy();
        // The decisive assertion: the side effect did not happen.
        expect(await readHeartbeat()).toBeNull();
      });
    });

    describe('health checks', () => {
      it('reports queue connectivity on readiness', async () => {
        const response = await request(app.getHttpServer())
          .get('/api/health/readiness')
          .expect(200);
        const body = response.body as {
          details: Record<string, { status: string }>;
        };
        expect(body.details.queue.status).toBe('up');
        expect(body.details.database.status).toBe('up');
      });

      it('keeps worker liveness OFF readiness so a stopped worker cannot pull the API out of rotation', async () => {
        // No heartbeat exists — truncateAll just flushed it — yet readiness is
        // still green.
        expect(await readHeartbeat()).toBeNull();
        const response = await request(app.getHttpServer())
          .get('/api/health/readiness')
          .expect(200);
        expect(response.body).not.toHaveProperty('details.queue_worker');
      });

      it('reports a missing worker heartbeat as unhealthy on its own endpoint', async () => {
        expect(await readHeartbeat()).toBeNull();
        const response = await request(app.getHttpServer())
          .get('/api/health/workers')
          .expect(503);

        // `/api/health/*` is @Public(), so the failure payload must carry no
        // internal topology (CWE-209). Two independent layers guarantee that
        // and this asserts the combined result: the indicator returns a fixed
        // string rather than the driver error (see queue.health.spec.ts), and
        // GlobalExceptionFilter then rewraps the 503 into the standard error
        // envelope, which drops terminus' details entirely.
        const failureBody = JSON.stringify(response.body);
        expect(failureBody).not.toContain('redis');
        expect(failureBody).not.toContain('6379');
        expect(failureBody).not.toContain('ECONNREFUSED');
      });

      it('reports a fresh worker heartbeat as healthy', async () => {
        await producer.enqueue(HEARTBEAT_JOB, heartbeatPayload());
        await waitUntil(
          async () => (await readHeartbeat()) !== null,
          'the heartbeat key to be written',
        );

        const response = await request(app.getHttpServer())
          .get('/api/health/workers')
          .expect(200);
        const body = response.body as {
          details: Record<string, { status: string }>;
        };
        expect(body.details.queue_worker.status).toBe('up');
      });
    });
  });

  // Its own app, because the assertion IS that shutdown tore everything down —
  // there would be nothing left for the other blocks to use.
  describe('graceful shutdown', () => {
    it('stops the worker and closes queue connections on app close', async () => {
      process.env.QUEUE_WORKER_ENABLED = 'true';
      const app = await createTestApp();
      const processor = app.get(MaintenanceQueueProcessor);
      const queue = app.get<Queue>(getQueueToken(QueueName.MAINTENANCE));
      expect(processor.worker.isRunning()).toBe(true);

      // Put the worker through a real job first. Closing an app the instant it
      // finished booting tears the consume loop down mid-start, which is not
      // the shutdown this is meant to prove — a deployed worker has always done
      // work before it gets a SIGTERM.
      const jobId = await app
        .get(QueueProducerService)
        .enqueue(HEARTBEAT_JOB, heartbeatPayload());
      await waitUntil(
        async () => (await queue.getJob(jobId))?.finishedOn !== undefined,
        'the job to finish before shutting down',
      );

      await app.close();

      // The real assertion. A worker still running after close() would keep
      // consuming jobs from a torn-down app, and its blocking Redis connection
      // would leak a socket per deploy and hang jest teardown.
      expect(processor.worker.isRunning()).toBe(false);
      expect(queue.closing).toBeDefined();
    });
  });
});
