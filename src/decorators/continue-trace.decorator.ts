import type { Attributes } from '@opentelemetry/api';
import type { TraceCarrier } from '../context/trace-carrier';
import { runWithTraceCarrier } from '../context/trace-carrier';
import { assertStringPropertyKey, preserveFunctionName, resolveDefaultName } from './decorator-utils';
import { copyMethodMetadata } from './copy-method-metadata';

export interface ContinueTraceOptions {
  /** Span name for the processing unit. Defaults to `ClassName.methodName`. */
  spanName?: string;
  /** Extra attributes recorded on the processing span. */
  attributes?: Attributes;
  /**
   * Reads the `TraceCarrier` captured at enqueue time off the decorated
   * method's own arguments. Defaults to reading a `trace` property off the
   * first argument (`args[0].trace`) — the shape `captureTraceCarrier()` is
   * meant to be spread into. Override for a different payload shape (e.g.
   * a differently named field, or a carrier nested deeper in the payload).
   */
  extractCarrier?: (...args: unknown[]) => TraceCarrier | undefined;
}

function defaultExtractCarrier(...args: unknown[]): TraceCarrier | undefined {
  const first = args[0] as { trace?: TraceCarrier } | undefined;
  return first?.trace;
}

function resolveOptions(options?: ContinueTraceOptions | string): ContinueTraceOptions {
  return typeof options === 'string' ? { spanName: options } : (options ?? {});
}

/**
 * Wraps a method (sync or async) so it runs resumed into whatever trace was
 * active when its caller captured a `TraceCarrier` via `captureTraceCarrier()`
 * — the ergonomic, queue-agnostic equivalent of `@Span()` for asynchronous
 * processing. The method body itself never touches `runWithTraceCarrier()`;
 * decorating it is the whole integration.
 *
 * @param options a span name, or {@link ContinueTraceOptions}.
 *
 * @example
 * ```ts
 * class InvoiceProcessor {
 *   @ContinueTrace('invoice.charge')
 *   async process(job: { invoiceId: string; trace: TraceCarrier }) {
 *     // runs already resumed into the original trace
 *   }
 * }
 *
 * // enqueue side, unchanged:
 * await queue.add('charge-invoice', { invoiceId, trace: captureTraceCarrier() });
 * ```
 */
export function ContinueTrace(options?: ContinueTraceOptions | string): MethodDecorator {
  const resolved = resolveOptions(options);
  const extractCarrier = resolved.extractCarrier ?? defaultExtractCarrier;

  return (target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor): PropertyDescriptor => {
    assertStringPropertyKey(propertyKey, '@ContinueTrace');

    const originalMethod = descriptor.value as (...args: unknown[]) => unknown;
    const spanName = resolved.spanName ?? resolveDefaultName(target, propertyKey);

    const wrapped = function (this: unknown, ...args: unknown[]): unknown {
      const carrier = extractCarrier(...args);
      return runWithTraceCarrier(carrier, () => originalMethod.apply(this, args), { spanName, attributes: resolved.attributes });
    };

    copyMethodMetadata(originalMethod, wrapped);
    preserveFunctionName(originalMethod, wrapped);
    descriptor.value = wrapped;
    return descriptor;
  };
}
