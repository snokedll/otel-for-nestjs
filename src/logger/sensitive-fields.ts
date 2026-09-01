/**
 * A field name, matched case-insensitively wherever it appears in a
 * redacted value — at any nesting depth, regardless of which transport
 * produced the value (an HTTP request/response, a Kafka/RabbitMQ event,
 * or any other structured metadata a call site passes to
 * {@link TraceLogger}) — e.g. `'authorization'` matches that key whether
 * it's under `headers`, under `body.request.headers`, or anywhere else.
 *
 * A pattern containing a `.` is instead matched as an exact dot-notation
 * path from the root of the logged value (e.g. `'body.card.number'`) —
 * useful when a bare name would be too broad (redacting every `number`
 * field anywhere, say) and only one specific location needs it.
 */
export type SensitiveFieldPattern = string;

/**
 * A starting point for `logs.sensitiveFields`
 * ({@link LogsSignalConfig.sensitiveFields}) — common credential/secret
 * carriers seen across HTTP headers and message metadata. Not applied
 * automatically: nothing is redacted unless the application configures
 * `logs.sensitiveFields` explicitly (this list included or not). Spread
 * it into your own list to opt in wholesale:
 *
 * ```ts
 * logs: { sensitiveFields: [...RECOMMENDED_SENSITIVE_FIELDS, 'cpf'] }
 * ```
 */
export const RECOMMENDED_SENSITIVE_FIELDS: SensitiveFieldPattern[] = [
  'authorization',
  'cookie',
  'set-cookie',
  'password',
  'token',
  'secret',
  'apikey',
  'api-key',
  'x-api-key',
  'access-token',
  'refresh-token',
];

/**
 * The value substituted for a redacted field when `logs.redactionPlaceholder`
 * ({@link LogsSignalConfig.redactionPlaceholder}) is left unconfigured.
 */
export const DEFAULT_REDACTION_PLACEHOLDER = '[REDACTED]';

/** Same guard as {@link resolveBodyPath} in `correlation-id-extractor.ts` — never walk into the prototype chain of caller-supplied data. */
const UNSAFE_PATH_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

function isDotPath(pattern: SensitiveFieldPattern): boolean {
  return pattern.includes('.');
}

function matchesField(key: string, path: string, patterns: SensitiveFieldPattern[]): boolean {
  const lowerKey = key.toLowerCase();
  const lowerPath = path.toLowerCase();
  return patterns.some((pattern) => {
    const lowerPattern = pattern.toLowerCase();
    return isDotPath(lowerPattern) ? lowerPattern === lowerPath : lowerPattern === lowerKey;
  });
}

function redactValue(value: unknown, patterns: SensitiveFieldPattern[], path: string, placeholder: string): unknown {
  if (Array.isArray(value)) return value.map((item) => redactValue(item, patterns, path, placeholder));
  if (value === null || typeof value !== 'object') return value;

  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (UNSAFE_PATH_SEGMENTS.has(key)) continue;
    const childPath = path ? `${path}.${key}` : key;
    result[key] = matchesField(key, childPath, patterns)
      ? placeholder
      : redactValue((value as Record<string, unknown>)[key], patterns, childPath, placeholder);
  }
  return result;
}

/**
 * Returns a deep copy of `value` with every field matching `patterns`
 * replaced by `placeholder` — the original object is never mutated.
 * `patterns` empty short-circuits to returning `value` itself, unchanged
 * (no copy made), since there's nothing to redact.
 *
 * @param placeholder the value every redacted field is replaced with.
 * Defaults to {@link DEFAULT_REDACTION_PLACEHOLDER} (`'[REDACTED]'`) — any
 * string works, e.g. `'***'` or `'<oculto>'`.
 */
export function redactSensitiveFields<T>(
  value: T,
  patterns: SensitiveFieldPattern[],
  placeholder: string = DEFAULT_REDACTION_PLACEHOLDER,
): T {
  if (patterns.length === 0) return value;
  return redactValue(value, patterns, '', placeholder) as T;
}

interface ActiveRedactionConfig {
  patterns: SensitiveFieldPattern[];
  placeholder: string;
}

// Set by `initializeTelemetry()` once the application's `TelemetryConfig`
// is resolved, read by `TraceLogger` on every call — never cached at
// construction time, so a `TraceLogger` instantiated before
// `initializeTelemetry()` runs (a class field, module scope, ...) still
// redacts correctly once real logging traffic happens, same reasoning as
// `MetricsService`'s deferred instrument resolution (see claude.md).
// `patterns` empty until then and if never configured — nothing is
// redacted unless the application explicitly configures `logs.sensitiveFields`.
let activeConfig: ActiveRedactionConfig = { patterns: [], placeholder: DEFAULT_REDACTION_PLACEHOLDER };

/** @internal Set by `initializeTelemetry()`. Not meant to be called directly by application code. */
export function setActiveRedactionConfig(config: ActiveRedactionConfig): void {
  activeConfig = config;
}

/** @internal Reset by `shutdownTelemetry()`. Not meant to be called directly by application code. */
export function resetActiveRedactionConfig(): void {
  activeConfig = { patterns: [], placeholder: DEFAULT_REDACTION_PLACEHOLDER };
}

/**
 * The sensitive-field patterns and placeholder {@link TraceLogger}
 * currently redacts with — `patterns` empty (nothing redacted) and
 * `placeholder` at its default until `initializeTelemetry()` resolves
 * whatever `logs.sensitiveFields`/`logs.redactionPlaceholder` the
 * application configured.
 */
export function getActiveRedactionConfig(): ActiveRedactionConfig {
  return activeConfig;
}
