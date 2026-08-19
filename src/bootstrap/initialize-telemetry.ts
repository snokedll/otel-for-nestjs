import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { resourceFromAttributes, type Resource } from '@opentelemetry/resources';
import { ATTR_DEPLOYMENT_ENVIRONMENT_NAME } from '@opentelemetry/semantic-conventions';
import { OTLPTraceExporter as OTLPTraceExporterJson } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPTraceExporter as OTLPTraceExporterProto } from '@opentelemetry/exporter-trace-otlp-proto';
import { OTLPLogExporter as OTLPLogExporterJson } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPLogExporter as OTLPLogExporterProto } from '@opentelemetry/exporter-logs-otlp-proto';
import { OTLPMetricExporter as OTLPMetricExporterJson, AggregationTemporalityPreference } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPMetricExporter as OTLPMetricExporterProto } from '@opentelemetry/exporter-metrics-otlp-proto';
import { BatchLogRecordProcessor, type LogRecordProcessor, type LogRecordExporter } from '@opentelemetry/sdk-logs';
import {
  PeriodicExportingMetricReader,
  type IMetricReader,
  type PushMetricExporter,
} from '@opentelemetry/sdk-metrics';
import { BatchSpanProcessor, type SpanProcessor, type SpanExporter } from '@opentelemetry/sdk-trace-base';
import {
  resolveTelemetryConfig,
  type TelemetryConfig,
  type OtlpProtocol,
  type ResolvedTelemetryConfig,
  type TemporalityPreference,
} from '../config/telemetry-config';

interface OtlpExporterOptions {
  url?: string;
}

interface MetricsExporterOptions extends OtlpExporterOptions {
  temporalityPreference?: AggregationTemporalityPreference;
}

interface SignalExporterFactories {
  traces: (options: OtlpExporterOptions) => SpanExporter;
  logs: (options: OtlpExporterOptions) => LogRecordExporter;
  metrics: (options: MetricsExporterOptions) => PushMetricExporter;
}

/** Strategy table: one exporter factory set per OTLP wire format. */
const EXPORTER_FACTORIES: Record<OtlpProtocol, SignalExporterFactories> = {
  'http/json': {
    traces: (options) => new OTLPTraceExporterJson(options),
    logs: (options) => new OTLPLogExporterJson(options),
    metrics: (options) => new OTLPMetricExporterJson(options),
  },
  'http/protobuf': {
    traces: (options) => new OTLPTraceExporterProto(options),
    logs: (options) => new OTLPLogExporterProto(options),
    metrics: (options) => new OTLPMetricExporterProto(options),
  },
};

function toExporterOptions(endpoint: string | undefined): OtlpExporterOptions {
  return endpoint ? { url: endpoint } : {};
}

const TEMPORALITY_PREFERENCE_BY_NAME: Record<TemporalityPreference, AggregationTemporalityPreference> = {
  cumulative: AggregationTemporalityPreference.CUMULATIVE,
  delta: AggregationTemporalityPreference.DELTA,
  lowmemory: AggregationTemporalityPreference.LOWMEMORY,
};

/**
 * Same as {@link toExporterOptions}, plus `temporalityPreference` when
 * configured. Left out entirely (rather than passed as `undefined`) when
 * not configured, so the exporter falls through to its own env-var-based
 * resolution (`OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE`) instead
 * of a hardcoded default fighting it.
 */
function toMetricsExporterOptions(resolved: ResolvedTelemetryConfig['metrics']): MetricsExporterOptions {
  const options: MetricsExporterOptions = toExporterOptions(resolved.endpoint);
  if (resolved.temporalityPreference) {
    options.temporalityPreference = TEMPORALITY_PREFERENCE_BY_NAME[resolved.temporalityPreference];
  }
  return options;
}

/**
 * Builds the `Resource` merged into `NodeSDK`'s own (`service.name`-derived)
 * resource. Only ever adds `deployment.environment.name` — the OTel
 * semantic-conventions attribute a Collector or backend uses to route a
 * trace/log/metric to the right dashboard by environment (`staging`,
 * `sandbox`, `production`, ...). `undefined` when `environment` is omitted,
 * so nothing is added and no environment is reported.
 */
function buildResource(resolved: ResolvedTelemetryConfig): Resource | undefined {
  if (!resolved.environment) return undefined;
  return resourceFromAttributes({ [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: resolved.environment });
}

/**
 * Builds the span/log/metric processor lists for `NodeSDK`. Disabled
 * signals resolve to an explicit empty array — `NodeSDK` falls back to
 * OTLP-exporting-to-`localhost:4318` env-based defaults for any processor
 * list left `undefined`, so omitting the key is not equivalent to
 * disabling the signal.
 */
function buildProcessors(resolved: ResolvedTelemetryConfig) {
  const factories = EXPORTER_FACTORIES[resolved.protocol];

  const spanProcessors: SpanProcessor[] = resolved.traces.enabled
    ? [new BatchSpanProcessor(factories.traces(toExporterOptions(resolved.traces.endpoint)))]
    : [];

  const logRecordProcessors: LogRecordProcessor[] = resolved.logs.enabled
    ? [new BatchLogRecordProcessor({ exporter: factories.logs(toExporterOptions(resolved.logs.endpoint)) })]
    : [];

  const metricReaders: IMetricReader[] = resolved.metrics.enabled
    ? [new PeriodicExportingMetricReader({ exporter: factories.metrics(toMetricsExporterOptions(resolved.metrics)) })]
    : [];

  return { spanProcessors, logRecordProcessors, metricReaders };
}

let activeSdk: NodeSDK | undefined;

/**
 * Initializes the OpenTelemetry SDK and registers auto-instrumentations.
 * `TelemetryModule.forRoot()` already calls this — most NestJS apps never
 * need to call it directly; it stays exported for advanced/non-Nest usage
 * (a plain Node script, a custom bootstrap order, etc).
 *
 * Idempotent by design: a second call while an SDK is already active is a
 * no-op that returns the SAME instance, rather than starting a second one.
 * This matters because `TelemetryModule.forRoot()` — and therefore this
 * function — can legitimately run more than once in the same process (a
 * test suite building several `Test.createTestingModule({ imports:
 * [TelemetryModule.forRoot(...)] })`, hot-reload in dev, ...); starting a
 * second `NodeSDK` would re-run `getNodeAutoInstrumentations()` against
 * already-patched modules, which is at best wasteful and at worst double
 * spans. Call {@link shutdownTelemetry} first if a genuine re-initialization
 * (e.g. with different config) is actually intended.
 *
 * @param config telemetry configuration; see {@link TelemetryConfig}.
 * @returns the active `NodeSDK` instance — freshly started, or the one
 * already running from a previous call.
 */
let shutdownSignalHandler: (() => void) | undefined;

export function initializeTelemetry(config: TelemetryConfig): NodeSDK {
  if (activeSdk) return activeSdk;

  const resolved = resolveTelemetryConfig(config);
  const { spanProcessors, logRecordProcessors, metricReaders } = buildProcessors(resolved);

  activeSdk = new NodeSDK({
    serviceName: resolved.serviceName,
    resource: buildResource(resolved),
    spanProcessors,
    logRecordProcessors,
    metricReaders,
    instrumentations: [getNodeAutoInstrumentations()],
  });

  activeSdk.start();

  // Named/stored (not `process.once(...)` with an inline closure) so
  // `shutdownTelemetry()` can remove them again — without this, a process
  // that goes through repeated initialize/shutdown cycles (a test suite
  // building several `TelemetryModule.forRoot()`-based testing modules,
  // for instance) would leak two listeners per cycle.
  shutdownSignalHandler = () => void shutdownTelemetry();
  process.once('SIGTERM', shutdownSignalHandler);
  process.once('SIGINT', shutdownSignalHandler);

  return activeSdk;
}

/**
 * Shuts down the active OpenTelemetry SDK, flushing any pending exports,
 * and removes the `SIGTERM`/`SIGINT` handlers {@link initializeTelemetry}
 * registered. A no-op when {@link initializeTelemetry} was never called.
 */
export async function shutdownTelemetry(): Promise<void> {
  if (!activeSdk) return;

  if (shutdownSignalHandler) {
    process.removeListener('SIGTERM', shutdownSignalHandler);
    process.removeListener('SIGINT', shutdownSignalHandler);
    shutdownSignalHandler = undefined;
  }

  await activeSdk.shutdown();
  activeSdk = undefined;
}
