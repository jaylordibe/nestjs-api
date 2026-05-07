import { Module } from '@nestjs/common';
import { ExampleHeartbeatService } from './example-heartbeat.service';

// Hosts cross-cutting scheduled jobs that don't belong to any feature
// module. Feature-owned jobs (e.g. "expire orders unpaid for 24h") should
// live inside the feature module itself, alongside the service that owns
// the data they work on — they only show up here when the work spans
// modules or the data has no obvious owner.
//
// `ScheduleModule.forRoot()` is registered once at the app level
// (app.module.ts); each @Cron decorator self-registers via the
// SchedulerRegistry. There's no per-environment gate at the module
// level — each scheduled job is responsible for being a no-op in test
// (typical pattern: `if (configService.get('nodeEnv') === 'test') return;`).
@Module({
  providers: [ExampleHeartbeatService],
})
export class ScheduledJobsModule {}
