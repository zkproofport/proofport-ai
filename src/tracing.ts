/**
 * OpenTelemetry tracing initialization for Phoenix integration.
 * Must be imported BEFORE all other imports in index.ts.
 *
 * Sends OTLP traces to Arize Phoenix for A2A task lifecycle visualization.
 * Disabled (no-op) when PHOENIX_COLLECTOR_ENDPOINT is not set.
 */
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

const endpoint = process.env.PHOENIX_COLLECTOR_ENDPOINT;

if (endpoint) {
  const exporter = new OTLPTraceExporter({
    url: `${endpoint}/v1/traces`,
  });

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: 'proveragent.eth',
      'project.name': 'proveragent.eth',
      'openinference.project.name': 'proveragent.eth',
    }),
    spanProcessors: [
      new SimpleSpanProcessor(exporter),
    ],
  });

  provider.register();
  console.log(`[tracing] OTLP protobuf exporter initialized → ${endpoint}/v1/traces`);
} else {
  console.log('[tracing] PHOENIX_COLLECTOR_ENDPOINT not set, tracing disabled');
}
