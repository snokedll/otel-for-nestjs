import { trace, SpanStatusCode, type Span as OtelSpan } from '@opentelemetry/api';
import { TraceContextManager, CORRELATION_ID_ATTRIBUTE } from '../context/trace-context';
import { resumeTraceCarrier } from '../context/trace-carrier';
import { assertStringPropertyKey, preserveFunctionName, resolveDefaultName } from './decorator-utils';
import { copyMethodMetadata } from './copy-method-metadata';
import { settleSyncOrAsync } from './settle-sync-or-async';
import { getContinueTraceExtractCarrier } from './continue-trace.decorator';

const TRACER_NAME = '@snokedll/otel-for-nestjs';

export interface SpanOptions {
  /** Custom span name. Defaults to `ClassName.methodName`. */
  name?: string;
  /** Custom attributes recorded on the span. */
  attributes?: Record<string, string | number | boolean>;
}

function resolveSpanOptions(options?: SpanOptions | string): SpanOptions {
  return typeof options === 'string' ? { name: options } : (options ?? {});
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
 * Wraps a method (sync or async) in an OpenTelemetry span via
 * `tracer.startActiveSpan()`. Use to name a span explicitly, or to measure
 * an operation not already covered by auto-instrumentation.
 *
 * Also tags the span with `app.correlation_id` whenever a correlation id
 * is active (`TraceContextManager.getCorrelationId()`) at the moment the
 * span starts — the same attribute `HttpTraceInterceptor`/
 * `MessageTraceInterceptor` set on the request/event's own span, so any
 * nested `@Span()` stays searchable by correlation id too, not just the
 * outermost span.
 *
 * Composes with `@ContinueTrace()` in **either order**: if the method also
 * carries `@ContinueTrace()` — detected via metadata, regardless of which
 * of the two was applied first — this resumes the captured trace before
 * starting the span, so the span always ends up parented to the resumed
 * trace. No decorator in this SDK requires a specific declaration order
 * relative to another.
 *
 * @param options a span name, or {@link SpanOptions}.
 *
 * @example
 * ```ts
 * class PaymentService {
 *   @Span('process-payment')
 *   async processPayment(orderId: string) { ... }
 * }
 * ```
 */
export function Span(options?: SpanOptions | string): MethodDecorator {
  const spanOptions = resolveSpanOptions(options);

  return (target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor): PropertyDescriptor => {
    assertStringPropertyKey(propertyKey, '@Span');

    const originalMethod = descriptor.value as (...args: unknown[]) => unknown;
    const spanName = spanOptions.name ?? resolveDefaultName(target, propertyKey);
    const extractCarrier = getContinueTraceExtractCarrier(originalMethod);

    const runSpan = function (this: unknown, ...args: unknown[]): unknown {
      return trace.getTracer(TRACER_NAME).startActiveSpan(spanName, (span) => {
        for (const [key, value] of Object.entries(spanOptions.attributes ?? {})) {
          span.setAttribute(key, value);
        }

        const correlationId = TraceContextManager.getCorrelationId();
        if (correlationId) span.setAttribute(CORRELATION_ID_ATTRIBUTE, correlationId);

        return settleSyncOrAsync(
          () => originalMethod.apply(this, args),
          (value) => finishOk(span, value),
          (error) => finishError(span, error),
        );
      });
    };

    // `originalMethod` also being a `@ContinueTrace()` wrapper (in either
    // wrapping position) means the trace must be resumed BEFORE this span
    // starts, so it is parented to the resumed trace rather than whatever
    // — if anything — was active before. Calling `originalMethod` again
    // inside `runSpan` re-resumes the same carrier a second time; harmless
    // (idempotent re-parenting), and far simpler than unwrapping it.
    const wrapped = extractCarrier
      ? function (this: unknown, ...args: unknown[]): unknown {
          return resumeTraceCarrier(extractCarrier(...args), () => runSpan.apply(this, args));
        }
      : runSpan;

    copyMethodMetadata(originalMethod, wrapped);
    preserveFunctionName(originalMethod, wrapped);
    descriptor.value = wrapped;
    return descriptor;
  };
}
