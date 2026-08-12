import {
  context as otelContext,
  trace,
  defaultTextMapGetter,
  defaultTextMapSetter,
  type SpanContext,
} from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';

const propagator = new W3CTraceContextPropagator();

/** Header-like carrier — HTTP headers, message headers, or any string-keyed map of string/string[] values. */
export type Carrier = Record<string, string | string[] | undefined>;

/**
 * Extracts a remote {@link SpanContext} from a `traceparent` (and optional
 * `tracestate`) entry of `carrier`, per the W3C Trace Context specification.
 *
 * @param carrier headers to read `traceparent`/`tracestate` from.
 * @returns the remote span context, or `undefined` if absent or invalid.
 */
export function extractW3CSpanContext(carrier: Carrier): SpanContext | undefined {
  const extracted = propagator.extract(otelContext.active(), carrier, defaultTextMapGetter);
  return trace.getSpanContext(extracted);
}

/**
 * Injects the `traceparent` (and `tracestate`, when present) of the
 * currently active OpenTelemetry context into an outbound carrier, so a
 * downstream service or message consumer can continue the same trace.
 *
 * @param carrier mutable header map to inject into.
 */
export function injectW3CTraceParent(carrier: Record<string, string>): void {
  propagator.inject(otelContext.active(), carrier, defaultTextMapSetter);
}

/**
 * Runs `fn` inside an OpenTelemetry context whose active span is
 * `spanContext`. Any span started within `fn` (via `tracer.startActiveSpan`)
 * becomes a child of it.
 *
 * @param spanContext the remote span to parent new spans to.
 * @param fn the function to run.
 * @returns whatever `fn` returns.
 */
export function runWithRemoteParent<T>(spanContext: SpanContext, fn: () => T): T {
  const contextWithParent = trace.setSpanContext(otelContext.active(), spanContext);
  return otelContext.with(contextWithParent, fn);
}
