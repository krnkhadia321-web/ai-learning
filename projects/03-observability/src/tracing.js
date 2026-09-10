/**
 * OpenTelemetry setup.
 *
 * MUST be imported before anything that creates spans — hence the bare
 * `import './tracing.js'` at the very top of server.js, before every other import.
 *
 * Why OpenTelemetry rather than a vendor SDK: it's the vendor-neutral standard. You
 * instrument once, and the same spans can be shipped to Jaeger, Grafana Tempo,
 * Datadog, Honeycomb, Langfuse — by changing an endpoint, not your code. Instrumenting
 * with a vendor's proprietary SDK is how teams end up unable to leave that vendor.
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';

// Tracing is OFF by default so the project runs with no Docker at all. The in-process
// ledger (see genai.js) still records everything either way — the trace export is the
// optional part, not the measurement.
const ENABLED = process.env.OTEL_ENABLED === 'true';
const ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318';

if (ENABLED) {
  // NONE by default: when Jaeger isn't running, the exporter retries and prints a wall
  // of connection errors that buries your actual application logs. Set OTEL_DEBUG=true
  // when you genuinely need to debug the pipeline itself.
  diag.setLogger(
    new DiagConsoleLogger(),
    process.env.OTEL_DEBUG === 'true' ? DiagLogLevel.DEBUG : DiagLogLevel.NONE,
  );

  const sdk = new NodeSDK({
    // The `resource` describes WHO is emitting the spans. Without a service name
    // every trace shows up as "unknown_service" and you can't tell your services
    // apart in the UI.
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? 'ai-learning-03',
      [ATTR_SERVICE_VERSION]: '1.0.0',
      'deployment.environment.name': process.env.NODE_ENV ?? 'development',
    }),
    traceExporter: new OTLPTraceExporter({ url: `${ENDPOINT}/v1/traces` }),
  });

  sdk.start();
  console.log(`▸ tracing → ${ENDPOINT}  (UI: http://localhost:16686)`);

  // WITHOUT THIS YOU LOSE THE LAST TRACES.
  //
  // Spans are batched in memory and flushed periodically — that's what makes tracing
  // cheap. But it means a process that exits immediately takes the un-flushed batch
  // with it. The bug this causes is maddening: traces appear fine while the server
  // runs, and the ones from just before a crash or restart — the ones you actually
  // need — are always missing.
  const shutdown = async () => {
    await sdk.shutdown().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
} else {
  console.log('▸ tracing disabled (set OTEL_ENABLED=true after `npm run jaeger:up`)');
}
