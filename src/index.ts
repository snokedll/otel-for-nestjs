export {
  TraceContextManager,
  CORRELATION_ID_ATTRIBUTE,
  type TraceContext,
  type TraceContextOverrides,
} from './context/trace-context';
export {
  extractW3CSpanContext,
  injectW3CTraceParent,
  runWithRemoteParent,
  type Carrier,
} from './context/w3c-propagation';
export { captureTraceCarrier, type TraceCarrier } from './context/trace-carrier';
export {
  extractCorrelationId,
  DEFAULT_CORRELATION_ID_SOURCES,
  CorrelationSource,
  type CorrelationIdSource,
} from './context/correlation-id-extractor';

export {
  resolveTelemetryConfig,
  type TelemetryConfig,
  type ResolvedTelemetryConfig,
  type SignalConfig,
  type OtlpProtocol,
} from './config/telemetry-config';

export { initializeTelemetry, shutdownTelemetry } from './bootstrap/initialize-telemetry';

export { TraceLogger, type LogLevel, type LogMetadata } from './logger/trace-logger';

export { MetricsService, type MetricAttributes, type MetricOptions } from './metrics/metrics.service';

export { Span, type SpanOptions } from './decorators/span.decorator';
export { Measure, type MeasureOptions } from './decorators/measure.decorator';
export { ContinueTrace, type ContinueTraceOptions } from './decorators/continue-trace.decorator';
export { copyMethodMetadata } from './decorators/copy-method-metadata';

export { BaseTraceInterceptor, type SignalOutcome } from './interceptors/base-trace.interceptor';
export { HttpTraceInterceptor } from './interceptors/http-trace.interceptor';
export { MessageTraceInterceptor } from './interceptors/message-trace.interceptor';
export { isRouteIgnored, isEventIgnored, type EventIgnoreRule, type RoutePattern } from './interceptors/ignore-matchers';

export { TelemetryModule } from './nestjs/telemetry.module';
export { TELEMETRY_CONFIG } from './nestjs/telemetry.tokens';
