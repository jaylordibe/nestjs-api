import { Injectable } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import { stopTelemetry } from '../../telemetry';

/**
 * Flushes OpenTelemetry on shutdown.
 *
 * Telemetry starts in `main.ts` before Nest exists (auto-instrumentation has to
 * patch modules before anything imports them), so it cannot start inside the
 * container. Stopping it, though, wants the container's own ordering: this runs
 * as part of `enableShutdownHooks()`, after the modules have closed, so spans
 * emitted while connections were draining are included rather than cut off.
 *
 * Existing purely so that shutdown is a lifecycle participant rather than a
 * `process.on('SIGTERM')` handler racing Nest for the same event.
 *
 * The worker entrypoint does not use this — it owns its own bounded shutdown
 * sequence and calls `stopTelemetry()` explicitly once its context has closed.
 */
@Injectable()
export class TelemetryShutdownService implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {
    await stopTelemetry();
  }
}
