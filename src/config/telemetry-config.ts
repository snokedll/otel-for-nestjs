import { DEFAULT_CORRELATION_ID_SOURCES, type CorrelationIdSource } from '../context/correlation-id-extractor';
import type { EventIgnoreRule, RoutePattern } from '../interceptors/ignore-matchers';

/** Enable/disable and endpoint override for a single telemetry signal (logs, traces, or metrics). */
export interface SignalConfig {
  /** Whether this signal is collected and exported. */
  enabled: boolean;
  /** OTel Collector URL for this signal specifically. Falls back to the top-level `endpoint` when omitted. */
  endpoint?: string;
}

/** OTLP wire format used when exporting to the Collector over HTTP. */
export type OtlpProtocol = 'http/json' | 'http/protobuf';

type SignalName = 'logs' | 'traces' | 'metrics';

/**
 * Complete telemetry configuration for the application — the single
 * source of truth passed to `TelemetryModule.forRoot()`, which both
 * initializes the OpenTelemetry SDK and registers the SDK's interceptors
 * in one call. Define it once, in its own module, and pass it to
 * `forRoot()` — see the SDK's README for the full setup.
 */
export interface TelemetryConfig {
  /** Reported as `service.name` on every trace, log, and metric. */
  serviceName: string;

  /**
   * Reported as `deployment.environment.name` (OTel semantic conventions)
   * on every trace, log, and metric — e.g. `'staging'`, `'sandbox'`,
   * `'production'`. Not a fixed enum: any string is accepted, since
   * different organizations name their environments differently. Omit to
   * not report an environment at all.
   */
  environment?: string;

  /**
   * Default OTel Collector URL, used by any enabled signal that doesn't
   * define its own `endpoint`. Example: `'http://otel-collector:4318'`.
   */
  endpoint?: string;

  /**
   * OTLP wire format for logs, traces, and metrics. `'http/protobuf'`
   * (default) is compact and recommended for production; `'http/json'` is
   * human-readable and convenient for local development.
   */
  protocol?: OtlpProtocol;

  /** Logs signal configuration. Enabled by default. */
  logs?: Partial<SignalConfig>;
  /** Traces signal configuration. Enabled by default. */
  traces?: Partial<SignalConfig>;
  /** Metrics signal configuration. Enabled by default. */
  metrics?: Partial<SignalConfig>;

  /**
   * Where to look for the correlation identifier of HTTP requests and
   * events — tried in order, the first match wins. Defaults to the
   * `x-correlation-id` / `correlation-id` / `correlationId` headers.
   *
   * @example
   * ```ts
   * correlationIdSources: [
   *   { from: 'header', key: 'x-correlation-id' },
   *   { from: 'body', key: 'metadata.correlationId' },
   * ]
   * ```
   */
  correlationIdSources?: CorrelationIdSource[];

  /**
   * HTTP routes `HttpTraceInterceptor` skips entirely — no trace context,
   * correlation identifier, or metric is produced for them. Useful for a
   * healthcheck endpoint polled continuously by an orchestrator or load
   * balancer.
   *
   * @example ['/health', /^\/internal\//]
   */
  ignoreRoutes?: RoutePattern[];

  /**
   * Message events `MessageTraceInterceptor` skips entirely, matched by
   * partial correspondence against the event's body and/or headers.
   *
   * @example [{ body: { name: 'HEALTH_CHECK' } }]
   */
  ignoreEvents?: EventIgnoreRule[];
}

/** {@link TelemetryConfig} with every default applied and every signal's endpoint fully resolved. */
export interface ResolvedTelemetryConfig {
  serviceName: string;
  environment?: string;
  protocol: OtlpProtocol;
  logs: SignalConfig;
  traces: SignalConfig;
  metrics: SignalConfig;
  correlationIdSources: CorrelationIdSource[];
  ignoreRoutes: RoutePattern[];
  ignoreEvents: EventIgnoreRule[];
}

const OTLP_PATH_BY_SIGNAL: Record<SignalName, string> = {
  logs: '/v1/logs',
  traces: '/v1/traces',
  metrics: '/v1/metrics',
};

const SLASH_CHAR_CODE = '/'.charCodeAt(0);

/**
 * Strips trailing `/` characters without a regex — `/\/+$/` is
 * polynomial-time on adversarial input (many slashes followed by a
 * non-slash character forces backtracking at every one of those
 * positions). `endpoint` ultimately traces back to caller-supplied
 * `TelemetryConfig`, so this is written to stay linear regardless.
 */
function stripTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === SLASH_CHAR_CODE) end -= 1;
  return url.slice(0, end);
}

function appendOtlpPathIfMissing(url: string, otlpPath: string): string {
  const trimmed = stripTrailingSlashes(url);
  return trimmed.endsWith(otlpPath) ? trimmed : `${trimmed}${otlpPath}`;
}

/**
 * Resolves the final endpoint for one signal: the signal-specific URL wins
 * when present, then the general `endpoint`, otherwise `undefined` (letting
 * the OTLP exporter fall back to its own `http://localhost:4318/v1/<signal>`
 * default). Either URL is left untouched if it already ends with the
 * expected OTLP path, so pre-qualified endpoints are never doubled up.
 */
function resolveEndpoint(specific: string | undefined, general: string | undefined, otlpPath: string): string | undefined {
  if (specific) return appendOtlpPathIfMissing(specific, otlpPath);
  if (general) return appendOtlpPathIfMissing(general, otlpPath);
  return undefined;
}

function resolveSignalConfig(name: SignalName, config: TelemetryConfig): SignalConfig {
  const partial = config[name];
  const enabled = partial?.enabled ?? true;
  return {
    enabled,
    endpoint: enabled ? resolveEndpoint(partial?.endpoint, config.endpoint, OTLP_PATH_BY_SIGNAL[name]) : undefined,
  };
}

function warnIfMissingEndpoint(name: SignalName, signal: SignalConfig): void {
  if (!signal.enabled || signal.endpoint) return;
  // eslint-disable-next-line no-console
  console.warn(
    `[@snokedll/otel-for-nestjs] Signal "${name}" is enabled without a configured endpoint. ` +
      `Falling back to the OTLP exporter default (http://localhost:4318). ` +
      `Set "endpoint" (shared) or "${name}.endpoint" (signal-specific) for production use.`,
  );
}

/**
 * Normalizes user-supplied {@link TelemetryConfig} into a fully resolved
 * {@link ResolvedTelemetryConfig}: every signal defaults to enabled, every
 * enabled signal's endpoint is fully resolved, and every interceptor
 * option defaults to its documented behavior. Used by both
 * `initializeTelemetry()` and `TelemetryModule.forRoot()` — each reads
 * only the fields it needs from the same resolved shape.
 *
 * @param config the raw, user-supplied configuration.
 */
export function resolveTelemetryConfig(config: TelemetryConfig): ResolvedTelemetryConfig {
  const resolved: ResolvedTelemetryConfig = {
    serviceName: config.serviceName,
    environment: config.environment,
    protocol: config.protocol ?? 'http/protobuf',
    logs: resolveSignalConfig('logs', config),
    traces: resolveSignalConfig('traces', config),
    metrics: resolveSignalConfig('metrics', config),
    correlationIdSources: config.correlationIdSources ?? DEFAULT_CORRELATION_ID_SOURCES,
    ignoreRoutes: config.ignoreRoutes ?? [],
    ignoreEvents: config.ignoreEvents ?? [],
  };

  (Object.keys(OTLP_PATH_BY_SIGNAL) as SignalName[]).forEach((name) => warnIfMissingEndpoint(name, resolved[name]));

  return resolved;
}
