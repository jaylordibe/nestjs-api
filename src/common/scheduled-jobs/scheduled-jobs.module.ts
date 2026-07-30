import { Module } from '@nestjs/common';
import { ExampleRetentionSweepService } from './example-retention-sweep.service';

// Hosts cross-cutting scheduled jobs that don't belong to any feature
// module. Feature-owned jobs (e.g. "expire orders unpaid for 24h") should
// live inside the feature module itself, alongside the service that owns
// the data they work on — they only show up here when the work spans
// modules or the data has no obvious owner.
//
// This module is the @Cron half of the app's background work. The other half
// is the BullMQ queue (src/common/queue/) — see the decision table at the top
// of its README for which mechanism a given job belongs on. They are not
// competitors: a sweep over all due rows stays here, per-entity work needing
// retries or cancellation goes on the queue.
//
// `ScheduleModule.forRoot()` is registered once at the app level
// (app.module.ts); each @Cron decorator self-registers via the
// SchedulerRegistry. There's no per-environment gate at the module
// level — each scheduled job is responsible for being a no-op in test
// (typical pattern: `if (configService.get('nodeEnv') === 'test') return;`).
@Module({
  providers: [ExampleRetentionSweepService],
})
export class ScheduledJobsModule {}
