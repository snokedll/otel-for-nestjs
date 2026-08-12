import type { ResolvedTelemetryConfig } from '../config/telemetry-config';

/**
 * Injection token for the {@link ResolvedTelemetryConfig} provided by
 * `TelemetryModule.forRoot()`. Inject it in any provider — including
 * `MessageTraceInterceptor`, applied outside of `TelemetryModule` itself —
 * to read the same resolved configuration the SDK's own interceptors use.
 */
export const TELEMETRY_CONFIG = Symbol('TELEMETRY_CONFIG');
