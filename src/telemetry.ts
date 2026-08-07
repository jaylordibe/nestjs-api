import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

// ─────────────────────────────────────────────────────────────────────────────
// OpenTelemetry bootstrap.
//
// ⚠️ THIS MODULE MUST BE IMPORTED BEFORE ANYTHING ELSE, in both entrypoints.
// Auto-instrumentation works by monkey-patching `http`, `pg`, `ioredis` and
// friends as they are required. Anything imported before the SDK starts holds a
// reference to the UNPATCHED module and is invisible forever after — and the
// failure is silent: no error, just traces that are quietly missing their
// database and outbound-HTTP spans. `main.ts` and `worker.ts` therefore import
// this file on their first line, above every other import.
//
// Why vendor-neutral OTLP rather than a Datadog/New Relic/Sentry SDK: the
// exporter is the only replaceable part of an observability stack, and baking a
// vendor into application code makes changing your mind a refactor. Point
// OTEL_EXPORTER_OTLP_ENDPOINT at an OpenTelemetry Collector and the Collector
// fans out to whatever backend you buy — including Prometheus scraping, which
// is why no `/metrics` endpoint is exposed here. One protocol out of the app,
// translation at the edge.
//
// OFF BY DEFAULT. With no endpoint configured the SDK never starts, so a fresh
// clone, a developer laptop, and the e2e suite pay nothing: no exporter
// retrying against a nonexistent collector, no noise in the logs.
// ─────────────────────────────────────────────────────────────────────────────

// How often metrics are pushed. 60s is the OTLP default and the right trade:
// metrics are aggregates, so a shorter interval multiplies egress without
// telling you much more.
const METRIC_EXPORT_INTERVAL_MILLISECONDS = 60_000;

let sdk: NodeSDK | null = null;

/**
 * Starts tracing and metrics, if an OTLP endpoint is configured.
 *
 * Reads `process.env` directly, which is the one deliberate exception to this
 * codebase's "config only through ConfigService" rule: this runs BEFORE the
 * Nest container exists, so there is no ConfigService to ask. The keys are
 * still declared in `env.validation.ts` so they are documented and validated
 * along with everything else.
 */
export function startTelemetry(): void {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!endpoint) return;

  const serviceName = process.env.SERVICE_NAME ?? 'nestjs-api';
  const serviceVersion = process.env.GIT_SHA ?? 'unknown';

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: serviceVersion,
    }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
      exportIntervalMillis: METRIC_EXPORT_INTERVAL_MILLISECONDS,
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // Filesystem spans are pure noise at this granularity — every template
        // read and every module load becomes a span, burying the request.
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-http': {
          // Health probes run every few seconds forever. Tracing them would
          // dominate the trace volume and tell you nothing you cannot read off
          // the probe itself.
          ignoreIncomingRequestHook: (request) =>
            (request.url ?? '').startsWith('/api/health'),
        },
      }),
    ],
  });

  sdk.start();
}

/**
 * Flushes pending spans and metrics on shutdown.
 *
 * Without this the last few seconds before a deploy or a crash-restart are
 * lost — which is exactly the window you go looking for when something went
 * wrong. Failures are swallowed: an unreachable collector must never be the
 * reason a process fails to exit.
 */
export async function stopTelemetry(): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.shutdown();
  } catch {
    // Deliberately silent. The logger may already be torn down at this point,
    // and there is no recovery available either way.
  }
  sdk = null;
}
