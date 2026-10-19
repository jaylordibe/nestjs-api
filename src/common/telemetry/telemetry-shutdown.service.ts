import { Injectable } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import { stopTelemetry } from '../../telemetry';

/**
 * Flushes OpenTelemetry on shutdown.
 *
 * Telemetry starts in `main.ts` before Nest exists (auto-instrumentation has to
 * patch modules before anything imports them), so it cannot start inside the
 * container. Stopping it, though, wants the container's own ordering: this runs
 * when the context closes, after the modules have closed, so spans emitted
 * while connections were draining are included rather than cut off.
 *
 * Both entrypoints close the context through `src/graceful-shutdown.ts`, which
 * also calls `stopTelemetry()` afterwards; the second call is a no-op. This
 * keeps any other `close()` (a test harness, a script) flushing too.
 */
@Injectable()
export class TelemetryShutdownService implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {
    await stopTelemetry();
  }
}
