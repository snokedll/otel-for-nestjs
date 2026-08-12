import { AsyncLocalStorage } from 'node:async_hooks';
import { trace, isSpanContextValid } from '@opentelemetry/api';
import { RandomIdGenerator } from '@opentelemetry/sdk-trace-base';

/**
 * Span/log attribute the correlation identifier is reported under —
 * shared between {@link TraceContextManager} (spans) and `TraceLogger`
 * (logs), so both signals become searchable by the same key in a backend
 * that supports attribute-based queries (e.g. Tempo TraceQL, Loki).
 */
export const CORRELATION_ID_ATTRIBUTE = 'app.correlation_id';

/**
 * Trace/correlation identifiers propagated through a single request,
 * message, or background operation.
 */
export interface TraceContext {
  /** W3C-formatted (32 hex char) trace identifier. */
  traceId: string;
  /** W3C-formatted (16 hex char) span identifier, when available. */
  spanId?: string;
  /** Business-level correlation identifier supplied by the caller. */
  correlationId?: string;
  /** Unix epoch milliseconds at which this context was created. */
  timestamp: number;
}

/**
 * Fields accepted when creating a new {@link TraceContext}. All fields are
 * optional; omitted identifiers are resolved from the active OpenTelemetry
 * span or freshly generated.
 */
export type TraceContextOverrides = Partial<Omit<TraceContext, 'timestamp'>>;

/**
 * Facade over {@link AsyncLocalStorage} that exposes the trace/correlation
 * identifiers of the operation currently in flight to any code running
 * within it — loggers, decorators, services — without those identifiers
 * being threaded through every function signature.
 */
export class TraceContextManager {
  private static readonly storage = new AsyncLocalStorage<TraceContext>();
  private static readonly idGenerator = new RandomIdGenerator();

  /** Generates a trace identifier in the same format OpenTelemetry itself uses. */
  static generateTraceId(): string {
    return this.idGenerator.generateTraceId();
  }

  /** Generates a span identifier in the same format OpenTelemetry itself uses. */
  static generateSpanId(): string {
    return this.idGenerator.generateSpanId();
  }

  /**
   * @returns the trace identifier of the active OpenTelemetry span, or
   * `undefined` when there is no active span, or the active span is a
   * no-op (unregistered `TracerProvider`).
   */
  static getActiveOtelTraceId(): string | undefined {
    const spanContext = trace.getActiveSpan()?.spanContext();
    return spanContext && isSpanContextValid(spanContext) ? spanContext.traceId : undefined;
  }

  /**
   * @returns the span identifier of the active OpenTelemetry span, or
   * `undefined` when there is no active span, or the active span is a
   * no-op (unregistered `TracerProvider`).
   */
  static getActiveOtelSpanId(): string | undefined {
    const spanContext = trace.getActiveSpan()?.spanContext();
    return spanContext && isSpanContextValid(spanContext) ? spanContext.spanId : undefined;
  }

  /**
   * Builds a new {@link TraceContext}, preferring identifiers from the
   * active OpenTelemetry span over generated ones. Explicit `overrides`
   * (for example a trace ID extracted from an inbound header) always win.
   *
   * When a correlation identifier is present, it is also set as the
   * `app.correlation_id` attribute on the currently active span — Grafana
   * Tempo (and any other TraceQL-capable backend) can then search traces
   * by it directly, the same way it already searches by `service.name`.
   * A silent no-op when there is no active span, or it is a non-recording
   * one (e.g. a remote-parent placeholder — see `runWithRemoteParent`).
   *
   * @param overrides identifiers to use instead of the resolved defaults.
   */
  static createContext(overrides?: TraceContextOverrides): TraceContext {
    if (overrides?.correlationId) {
      trace.getActiveSpan()?.setAttribute(CORRELATION_ID_ATTRIBUTE, overrides.correlationId);
    }

    return {
      traceId: overrides?.traceId ?? this.getActiveOtelTraceId() ?? this.generateTraceId(),
      spanId: overrides?.spanId ?? this.getActiveOtelSpanId(),
      correlationId: overrides?.correlationId,
      timestamp: Date.now(),
    };
  }

  /**
   * Sets `context` as current for the rest of the active async execution,
   * without an explicit callback scope.
   */
  static setContext(context: TraceContext): void {
    this.storage.enterWith(context);
  }

  /**
   * Runs `fn` with `context` set as current, isolated from whatever
   * context was active outside of it.
   *
   * @param context the {@link TraceContext} to expose during `fn`.
   * @param fn the function to run.
   * @returns whatever `fn` returns.
   */
  static run<T>(context: TraceContext, fn: () => T): T {
    return this.storage.run(context, fn);
  }

  /** @returns the current {@link TraceContext}, or `undefined` if none was set. */
  static getContext(): TraceContext | undefined {
    return this.storage.getStore();
  }

  /**
   * @returns the current trace identifier: from the stored context, then
   * the active OpenTelemetry span, then the literal `'no-trace-context'`
   * as a last resort.
   */
  static getTraceId(): string {
    return this.getContext()?.traceId ?? this.getActiveOtelTraceId() ?? 'no-trace-context';
  }

  /** @returns the current span identifier, from the stored context or the active OpenTelemetry span. */
  static getSpanId(): string | undefined {
    return this.getContext()?.spanId ?? this.getActiveOtelSpanId();
  }

  /** @returns the current correlation identifier, if one was set. */
  static getCorrelationId(): string | undefined {
    return this.getContext()?.correlationId;
  }

  /**
   * Sets the correlation identifier on the current context, creating one
   * first if none exists yet.
   */
  static setCorrelationId(correlationId: string): void {
    const current = this.getContext();
    if (current) {
      current.correlationId = correlationId;
      return;
    }
    this.setContext(this.createContext({ correlationId }));
  }
}
