import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  HealthCheck,
  HealthCheckResult,
  HealthCheckService,
  HealthIndicatorFunction,
  MemoryHealthIndicator,
} from '@nestjs/terminus';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { HealthVersionResponseDto } from './dto/health-version-response.dto';
import { PrismaHealthIndicator } from './indicators/prisma.health';

// Captured at module load — i.e. when the container's Node process
// starts. Curl /api/health/version after a deploy: a startedAt that
// matches your deploy time confirms the container actually restarted.
const PROCESS_BOOT_TIME = new Date().toISOString();

@ApiTags('Health')
@Controller('health')
@SkipThrottle()
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prismaHealth: PrismaHealthIndicator,
    private readonly memory: MemoryHealthIndicator,
    private readonly configService: ConfigService,
  ) {}

  @Get('liveness')
  @HealthCheck()
  liveness(): Promise<HealthCheckResult> {
    const indicators: HealthIndicatorFunction[] = [];
    // Heap-ceiling check is an operational guardrail for prod (catches
    // runaway memory before the orchestrator OOM-kills the pod). It's
    // skipped in test because Jest runs every e2e suite in one worker —
    // each createTestApp() bootstraps a fresh AppModule and the GC
    // doesn't fully reclaim between suites, so the ceiling flaps even
    // though the app itself isn't leaking. Routing/wiring is what the
    // suite actually verifies; memory behavior is a separate concern.
    if (this.configService.get<string>('nodeEnv') !== 'test') {
      indicators.push(() =>
        this.memory.checkHeap('memory_heap', 512 * 1024 * 1024),
      );
    }
    return this.health.check(indicators);
  }

  @Get('readiness')
  @HealthCheck()
  readiness(): Promise<HealthCheckResult> {
    return this.health.check([() => this.prismaHealth.pingCheck('database')]);
  }

  // Returns the commit hash baked into this image at build time (via the
  // GIT_SHA Docker arg in the deploy workflows) and the moment the Node
  // process started. After a deploy:
  //   - `commit` should match the SHA of the deploy's HEAD
  //   - `startedAt` should be within seconds of the deploy timestamp
  // If either is wrong, the deploy didn't actually replace the running
  // container — usually because `docker compose up -d` ran without
  // `--build`, or layer caching reused a stale `dist/`.
  @Get('version')
  @ApiOkResponse({ type: HealthVersionResponseDto })
  version(): HealthVersionResponseDto {
    return {
      commit: this.configService.getOrThrow<string>('gitSha'),
      startedAt: PROCESS_BOOT_TIME,
    };
  }
}
