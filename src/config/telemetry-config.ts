import { DEFAULT_CORRELATION_ID_SOURCES, type CorrelationIdSource } from '../context/correlation-id-extractor';
import type { EventIgnoreRule, RoutePattern } from '../interceptors/ignore-matchers';
import { DEFAULT_REDACTION_PLACEHOLDER, type SensitiveFieldPattern } from '../logger/sensitive-fields';

/** Enable/disable and endpoint override for a single telemetry signal (logs, traces, or metrics). */
export interface SignalConfig {
  /** Whether this signal is collected and exported. */
  enabled: boolean;
  /**
   * OTel Collector URL for this signal specifically. Falls back to the
   * top-level `endpoint` when omitted. A bare origin (`http://collector:4318`,
   * with or without a trailing slash) gets the signal's OTLP path appended
   * automatically (`/v1/logs`, `/v1/traces`, `/v1/metrics`); a URL with any
   * path of its own (a Collector mounted under a custom base path, a
   * gateway prefix, ...) is trusted completely and used exactly as given.
   */
  endpoint?: string;
}

/** OTLP wire format used when exporting to the Collector over HTTP. */
export type OtlpProtocol = 'http/json' | 'http/protobuf';

/**
 * Aggregation temporality reported for Sum-type metrics (counters,
 * histograms) — see {@link MetricsSignalConfig.temporalityPreference}.
 */
export type TemporalityPreference = 'cumulative' | 'delta' | 'lowmemory';

/** {@link SignalConfig} plus the metrics-only temporality knob. */
export interface MetricsSignalConfig extends SignalConfig {
  /**
   * Aggregation temporality sent to the OTLP metrics exporter.
   * `'cumulative'` (default, matches the OpenTelemetry spec default)
   * reports each data point as a running total since the process
   * started; `'delta'` reports only the change since the last export;
   * `'lowmemory'` uses delta for counters/histograms and cumulative for
   * everything else, trading a bit of accuracy for not having to keep
   * every data point's running total in memory.
   *
   * Some backends only accept `'delta'` for Sum-type metrics (counters,
   * histograms) and silently drop anything reported as `'cumulative'` —
   * with no export error on the sending side, since the Collector still
   * accepts and forwards the payload; the rejection happens further
   * downstream, invisible to this SDK. If metrics never show up despite
   * no export error being logged, this is worth trying. Equivalent to
   * the standard `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE` env
   * var, which is used automatically when this is left unset — set here,
   * this option takes priority over that env var.
   */
  temporalityPreference?: TemporalityPreference;
}

/** {@link SignalConfig} plus the logs-only sensitive-field redaction knob. */
export interface LogsSignalConfig extends SignalConfig {
  /**
   * Field names (or dot-notation paths) `TraceLogger` redacts from every
   * logged metadata object. Empty by default — nothing is redacted
   * unless configured explicitly here; see {@link RECOMMENDED_SENSITIVE_FIELDS}
   * for a starting-point list (`authorization`, `cookie`, `password`,
   * ...) to spread into this array.
   *
   * A bare name (`'cpf'`) matches that key wherever it appears, at any
   * nesting depth, regardless of which transport produced it — an HTTP
   * request/response, a Kafka/RabbitMQ event, or any other structured
   * metadata a call site passes to `TraceLogger`. A dot-notation path
   * (`'body.card.number'`) matches only that exact location, for when a
   * bare name would be too broad. Matching is case-insensitive either way.
   *
   * @example ['cpf', 'cardNumber', 'body.customer.email']
   */
  sensitiveFields: SensitiveFieldPattern[];

  /**
   * Value substituted for every field matched by `sensitiveFields`.
   * Defaults to `'[REDACTED]'` ({@link DEFAULT_REDACTION_PLACEHOLDER}) —
   * any string works, e.g. `'***'` or `'<oculto>'`.
   */
  redactionPlaceholder: string;
}

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
   * Same bare-origin-vs-custom-path handling as {@link SignalConfig.endpoint}.
   */
  endpoint?: string;

  /**
   * OTLP wire format for logs, traces, and metrics. `'http/protobuf'`
   * (default) is compact and recommended for production; `'http/json'` is
   * human-readable and convenient for local development.
   */
  protocol?: OtlpProtocol;

  /** Logs signal configuration. Enabled by default. */
  logs?: Partial<LogsSignalConfig>;
  /** Traces signal configuration. Enabled by default. */
  traces?: Partial<SignalConfig>;
  /** Metrics signal configuration. Enabled by default. */
  metrics?: Partial<MetricsSignalConfig>;

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
  logs: LogsSignalConfig;
  traces: SignalConfig;
  metrics: MetricsSignalConfig;
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

/**
 * Appends `otlpPath` only when `url` is a bare origin — nothing after the
 * host[:port] but an empty or root (`/`) path, e.g. `http://collector:4318`
 * or `http://collector:4318/`. Any URL that already has a path of its own
 * — a Collector mounted under a custom base path, a gateway prefix, or
 * already the exact expected OTLP path — is trusted completely and
 * returned untouched, so it's never doubled up or reshaped.
 *
 * `URL` is used instead of string matching specifically so a custom path
 * is respected regardless of what it looks like; a value that isn't a
 * parseable absolute URL is left as-is rather than guessed at.
 */
function appendOtlpPathForBareOrigin(url: string, otlpPath: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  if (parsed.pathname !== '' && parsed.pathname !== '/') return url;
  return `${stripTrailingSlashes(url)}${otlpPath}`;
}

/**
 * Resolves the final endpoint for one signal: the signal-specific URL wins
 * when present, then the general `endpoint`, otherwise `undefined` (letting
 * the OTLP exporter fall back to its own `http://localhost:4318/v1/<signal>`
 * default). See {@link appendOtlpPathForBareOrigin} for exactly when the
 * signal's OTLP path does and doesn't get appended.
 */
function resolveEndpoint(specific: string | undefined, general: string | undefined, otlpPath: string): string | undefined {
  if (specific) return appendOtlpPathForBareOrigin(specific, otlpPath);
  if (general) return appendOtlpPathForBareOrigin(general, otlpPath);
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

function resolveMetricsConfig(config: TelemetryConfig): MetricsSignalConfig {
  return {
    ...resolveSignalConfig('metrics', config),
    // Left unset (rather than defaulted) when the caller doesn't configure
    // it, so the exporter falls through to
    // OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE / its own
    // 'cumulative' default — same precedence the env var itself documents.
    temporalityPreference: config.metrics?.temporalityPreference,
  };
}

function resolveLogsConfig(config: TelemetryConfig): LogsSignalConfig {
  return {
    ...resolveSignalConfig('logs', config),
    // Explicit only — nothing redacted unless the application configures
    // this itself. See RECOMMENDED_SENSITIVE_FIELDS for a starting point.
    sensitiveFields: config.logs?.sensitiveFields ?? [],
    redactionPlaceholder: config.logs?.redactionPlaceholder ?? DEFAULT_REDACTION_PLACEHOLDER,
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
    logs: resolveLogsConfig(config),
    traces: resolveSignalConfig('traces', config),
    metrics: resolveMetricsConfig(config),
    correlationIdSources: config.correlationIdSources ?? DEFAULT_CORRELATION_ID_SOURCES,
    ignoreRoutes: config.ignoreRoutes ?? [],
    ignoreEvents: config.ignoreEvents ?? [],
  };

  (Object.keys(OTLP_PATH_BY_SIGNAL) as SignalName[]).forEach((name) => warnIfMissingEndpoint(name, resolved[name]));

  return resolved;
}
