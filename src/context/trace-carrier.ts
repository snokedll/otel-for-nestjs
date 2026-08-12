import { trace, SpanStatusCode, isSpanContextValid, type Attributes, type Span as OtelSpan } from '@opentelemetry/api';
import { extractW3CSpanContext, injectW3CTraceParent, runWithRemoteParent } from './w3c-propagation';
import { TraceContextManager } from './trace-context';
import { settleSyncOrAsync } from '../decorators/settle-sync-or-async';

const TRACER_NAME = '@snokedll/otel-for-nestjs';

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
 * Options accepted by {@link runWithTraceCarrier} — an internal building
 * block for `@ContinueTrace()`, not part of the SDK's public API (not
 * re-exported from the package root).
 */
export interface RunWithTraceCarrierOptions {
  /** Span name for the processing unit. Defaults to `'async.process'`. */
  spanName?: string;
  /** Extra attributes recorded on the processing span. */
  attributes?: Attributes;
}

function finishOk(span: OtelSpan, value: unknown): unknown {
  span.setStatus({ code: SpanStatusCode.OK });
  span.end();
  return value;
}

function finishError(span: OtelSpan, error: unknown): never {
  span.recordException(error as Error);
  span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error)?.message });
  span.end();
  throw error;
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
 * Runs `fn` as a new span, directly linked to whatever trace was active
 * when `carrier` was captured — the SAME trace id flows through, whether
 * the gap in between was a Bull/BullMQ job, a RabbitMQ/Kafka message, or a
 * plain `setTimeout`/`setInterval` callback.
 *
 * Not part of the SDK's public API — it is the mechanism `@ContinueTrace()`
 * wraps for consumer-side methods, and is not re-exported from the package
 * root. Use `@ContinueTrace()` instead.
 *
 * `fn`'s own trace/correlation context (readable via `TraceContextManager`,
 * and used automatically by `TraceLogger`) is set up before it runs, so
 * logs emitted from within `fn` carry the original trace id too — this is
 * the mechanism that gives an async worker a direct, provable link back to
 * the request/event that scheduled it, regardless of the queue technology.
 *
 * When `carrier` is `undefined` or carries no valid `traceparent` (never
 * captured, corrupted in transit, or the job predates this feature), `fn`
 * still runs — just as the root of a fresh trace, exactly like an
 * unparented `@Span()` call would.
 *
 * @param carrier the value produced by {@link captureTraceCarrier} at enqueue time.
 * @param fn the operation to run (sync or async).
 * @param options span name/attributes for the processing unit.
 * @returns whatever `fn` returns, preserving sync-vs-`Promise` shape.
 */
export function runWithTraceCarrier<T>(carrier: TraceCarrier | undefined, fn: () => T, options?: RunWithTraceCarrierOptions): T {
  const remoteParent = carrier?.traceparent
    ? extractW3CSpanContext({ traceparent: carrier.traceparent, tracestate: carrier.tracestate })
    : undefined;

  const runInstrumented = (): T =>
    trace.getTracer(TRACER_NAME).startActiveSpan(options?.spanName ?? 'async.process', { attributes: options?.attributes }, (span) => {
      const traceContext = TraceContextManager.createContext({ correlationId: carrier?.correlationId });

      return settleSyncOrAsync(
        () => TraceContextManager.run(traceContext, fn),
        (value) => finishOk(span, value),
        (error) => finishError(span, error),
      ) as T;
    });

  return remoteParent && isSpanContextValid(remoteParent) ? runWithRemoteParent(remoteParent, runInstrumented) : runInstrumented();
}
