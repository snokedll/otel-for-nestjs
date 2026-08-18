import { isSpanContextValid } from '@opentelemetry/api';
import { extractW3CSpanContext, injectW3CTraceParent, runWithRemoteParent } from './w3c-propagation';
import { TraceContextManager } from './trace-context';

/**
 * Serializable snapshot of the trace/correlation identifiers in flight at
 * the moment work is handed off to an asynchronous mechanism — a Bull/
 * BullMQ job payload, a RabbitMQ message, a Kafka record, an in-memory
 * queue, even a plain `setTimeout` closure. Deliberately queue-technology
 * agnostic: it is just data (three optional strings), so it travels
 * wherever the caller already puts the job's own payload — there is no
 * transport-specific header convention to depend on.
 */
export interface TraceCarrier {
  /** W3C `traceparent` value at capture time. Absent when there was no active trace. */
  traceparent?: string;
  /** W3C `tracestate` value at capture time, if any. */
  tracestate?: string;
  /** Business correlation identifier active at capture time, if any. */
  correlationId?: string;
}

/**
 * Captures the trace/correlation identifiers of the operation currently in
 * flight, to be serialized into a queue job/message payload alongside its
 * own data. Call it where the job is enqueued/published — inside the HTTP
 * request or event handler that triggers it, while the originating trace
 * is still active.
 *
 * @returns a plain, JSON-serializable object — `{}` (never `undefined`)
 * when there is no active trace, so the shape stays uniform for callers
 * that always spread it into a payload.
 *
 * @example
 * ```ts
 * async function scheduleInvoiceCharge(invoiceId: string) {
 *   await queue.add('charge-invoice', { invoiceId, trace: captureTraceCarrier() });
 * }
 * ```
 */
export function captureTraceCarrier(): TraceCarrier {
  const injected: Record<string, string> = {};
  injectW3CTraceParent(injected);

  const correlationId = TraceContextManager.getCorrelationId();

  return {
    ...(injected.traceparent ? { traceparent: injected.traceparent } : {}),
    ...(injected.tracestate ? { tracestate: injected.tracestate } : {}),
    ...(correlationId ? { correlationId } : {}),
  };
}

/**
 * Runs `fn` with the trace/correlation context active when `carrier` was
 * captured resumed — the SAME trace id flows through, whether the gap in
 * between was a Bull/BullMQ job, a RabbitMQ/Kafka message, or a plain
 * `setTimeout`/`setInterval` callback.
 *
 * Deliberately does not create a span of its own — resuming a trace and
 * naming a span are two different concerns (the same split as `@Span()`
 * vs `@Measure()`). Pair this with `@Span()` (or a manual
 * `tracer.startActiveSpan()`) to get a visible, named span for the
 * resumed work; without one, the resumed trace/correlation-id still shows
 * up in logs and in any further auto-instrumented call made from within
 * `fn`, just without a span of its own marking the processing unit.
 *
 * Not part of the SDK's public API — it is the mechanism `@ContinueTrace()`
 * wraps for consumer-side methods, and is not re-exported from the package
 * root. Use `@ContinueTrace()` instead.
 *
 * When `carrier` is `undefined` or carries no valid `traceparent` (never
 * captured, corrupted in transit, or the job predates this feature), `fn`
 * still runs — just as the root of a fresh trace, exactly like an
 * unparented `@Span()` call would.
 *
 * @param carrier the value produced by {@link captureTraceCarrier} at enqueue time.
 * @param fn the operation to run (sync or async).
 * @returns whatever `fn` returns, preserving sync-vs-`Promise` shape.
 */
export function resumeTraceCarrier<T>(carrier: TraceCarrier | undefined, fn: () => T): T {
  const remoteParent = carrier?.traceparent
    ? extractW3CSpanContext({ traceparent: carrier.traceparent, tracestate: carrier.tracestate })
    : undefined;

  const runInContext = (): T => {
    const traceContext = TraceContextManager.createContext({ correlationId: carrier?.correlationId });
    return TraceContextManager.run(traceContext, fn);
  };

  return remoteParent && isSpanContextValid(remoteParent) ? runWithRemoteParent(remoteParent, runInContext) : runInContext();
}
