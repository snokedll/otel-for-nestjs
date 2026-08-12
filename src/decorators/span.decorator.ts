import { trace, SpanStatusCode, type Span as OtelSpan } from '@opentelemetry/api';
import { assertStringPropertyKey, preserveFunctionName, resolveDefaultName } from './decorator-utils';
import { copyMethodMetadata } from './copy-method-metadata';
import { settleSyncOrAsync } from './settle-sync-or-async';

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

    const wrapped = function (this: unknown, ...args: unknown[]): unknown {
      return trace.getTracer(TRACER_NAME).startActiveSpan(spanName, (span) => {
        for (const [key, value] of Object.entries(spanOptions.attributes ?? {})) {
          span.setAttribute(key, value);
        }

        return settleSyncOrAsync(
          () => originalMethod.apply(this, args),
          (value) => finishOk(span, value),
          (error) => finishError(span, error),
        );
      });
    };

    copyMethodMetadata(originalMethod, wrapped);
    preserveFunctionName(originalMethod, wrapped);
    descriptor.value = wrapped;
    return descriptor;
  };
}
