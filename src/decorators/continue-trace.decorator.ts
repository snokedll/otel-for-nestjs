import type { TraceCarrier } from '../context/trace-carrier';
import { resumeTraceCarrier } from '../context/trace-carrier';
import { assertStringPropertyKey, preserveFunctionName } from './decorator-utils';
import { copyMethodMetadata } from './copy-method-metadata';

export interface ContinueTraceOptions {
  /**
   * Reads the `TraceCarrier` captured at enqueue time off the decorated
   * method's own arguments.
   *
   * Typed with `any[]`, not `unknown[]` — the parameter list of a job
   * processor is whatever shape the caller's queue library defines (a
   * `Job<T>`, a plain payload object, ...), and TypeScript would otherwise
   * reject a normally-typed function here: `unknown` is not assignable to
   * a specific parameter type, so `(job: Job<X>) => ...` would fail to
   * satisfy `(...args: unknown[]) => ...`. Same reasoning NestJS itself
   * uses for `FactoryProvider.useFactory`/`inject`.
   *
   * Defaults to reading a `trace` property off the first argument
   * (`args[0].trace`) — the shape a plain `queue.add('name', { ...payload,
   * trace: captureTraceCarrier() })` call produces, where the processor
   * receives that payload object directly as its first parameter (RabbitMQ
   * consumers, `@nestjs/microservices` custom transports, a raw
   * `setTimeout` callback, ...).
   *
   * Override this whenever the carrier is NOT at `args[0].trace` — the
   * most common case being **Bull/BullMQ**, where a processor's first
   * argument is a `Job` wrapper, not the payload itself: the payload (and
   * therefore the carrier) lives one level deeper, at `job.data`.
   *
   * @example
   * ```ts
   * // Enqueue side (Bull/BullMQ) — trace lives inside the job's data, like any other field:
   * await queue.add('charge-invoice', { invoiceId, trace: captureTraceCarrier() });
   * ```
   * ```ts
   * // Bull (`@nestjs/bull`) processor — Job.data holds what was enqueued above:
   * import { Processor, Process } from '@nestjs/bull';
   * import type { Job } from 'bull';
   *
   * @Processor('invoices')
   * class InvoiceProcessor {
   *   @Process('charge-invoice')
   *   @Span('invoice.charge')
   *   @ContinueTrace({
   *     extractCarrier: (job: Job<{ invoiceId: string; trace: TraceCarrier }>) => job.data.trace,
   *   })
   *   async handleCharge(job: Job<{ invoiceId: string; trace: TraceCarrier }>) {
   *     // job.data.invoiceId, resumed into the original trace
   *   }
   * }
   * ```
   */
  extractCarrier?: (...args: any[]) => TraceCarrier | undefined;
}

type ExtractCarrierFn = (...args: any[]) => TraceCarrier | undefined;

interface MetadataReflect {
  getMetadata?(metadataKey: unknown, target: object): unknown;
  defineMetadata?(metadataKey: unknown, metadataValue: unknown, target: object): void;
}

/**
 * Not a public export — `reflect-metadata` key `@Span()` looks up (via
 * {@link getContinueTraceExtractCarrier}) to detect that a method also
 * carries `@ContinueTrace()`, regardless of which of the two was applied
 * first. `copyMethodMetadata` (used by every method decorator in this SDK)
 * copies this key like any other, so it survives being wrapped further —
 * by `@Measure()` sitting between the two, for instance.
 */
const CONTINUE_TRACE_EXTRACT_CARRIER = Symbol('otel-for-nestjs:continueTraceExtractCarrier');

function markContinueTrace(target: object, extractCarrier: ExtractCarrierFn): void {
  const reflect = Reflect as typeof Reflect & MetadataReflect;
  reflect.defineMetadata?.(CONTINUE_TRACE_EXTRACT_CARRIER, extractCarrier, target);
}

/**
 * @returns the `extractCarrier` function a `@ContinueTrace()` elsewhere in
 * the decorator stack attached to `target`, if any. Used by `@Span()` to
 * resume the trace before creating its own span even when `@ContinueTrace()`
 * is the innermost (closest to the method) of the two.
 */
export function getContinueTraceExtractCarrier(target: object): ExtractCarrierFn | undefined {
  const reflect = Reflect as typeof Reflect & MetadataReflect;
  if (typeof reflect.getMetadata !== 'function') return undefined;
  return reflect.getMetadata(CONTINUE_TRACE_EXTRACT_CARRIER, target) as ExtractCarrierFn | undefined;
}

function defaultExtractCarrier(...args: any[]): TraceCarrier | undefined {
  const first = args[0] as { trace?: TraceCarrier } | undefined;
  return first?.trace;
}

/**
 * Wraps a method (sync or async) so it runs resumed into whatever trace was
 * active when its caller captured a `TraceCarrier` via `captureTraceCarrier()`
 * — the queue-agnostic mechanism for trace continuity across asynchronous
 * processing. The method body itself never touches trace-carrier internals;
 * decorating it is the whole integration.
 *
 * Deliberately does only that — resuming trace/correlation-id context —
 * and does not create a span of its own: naming a span is `@Span()`'s job,
 * not this one, the same separation of concerns as `@Span()` vs
 * `@Measure()`. Composes with `@Span()` in **either order** — same
 * guarantee as every other decorator pair in this SDK. Whichever order you
 * write them in, `@Span()`'s span always ends up parented to the resumed
 * trace, never the other way around:
 *
 * ```ts
 * class InvoiceProcessor {
 *   @ContinueTrace()
 *   @Span('invoice.charge')
 *   async process(job: { invoiceId: string; trace: TraceCarrier }) { ... }
 * }
 * ```
 * ```ts
 * class InvoiceProcessor {
 *   @Span('invoice.charge')
 *   @ContinueTrace()
 *   async process(job: { invoiceId: string; trace: TraceCarrier }) { ... }
 * }
 * ```
 *
 * Using `@ContinueTrace()` alone (no `@Span()`) is valid — logs emitted
 * from within the method, and any further auto-instrumented call it makes
 * (an HTTP request, a DB query, another message publish), still correctly
 * attach to the resumed trace. What is missing without `@Span()` is a span
 * of the processing unit itself showing up in the trace.
 *
 * @param options see {@link ContinueTraceOptions}.
 */
export function ContinueTrace(options?: ContinueTraceOptions): MethodDecorator {
  const extractCarrier = options?.extractCarrier ?? defaultExtractCarrier;

  return (_target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor): PropertyDescriptor => {
    assertStringPropertyKey(propertyKey, '@ContinueTrace');

    const originalMethod = descriptor.value as (...args: unknown[]) => unknown;

    const wrapped = function (this: unknown, ...args: unknown[]): unknown {
      const carrier = extractCarrier(...args);
      return resumeTraceCarrier(carrier, () => originalMethod.apply(this, args));
    };

    copyMethodMetadata(originalMethod, wrapped);
    preserveFunctionName(originalMethod, wrapped);
    markContinueTrace(wrapped, extractCarrier);
    descriptor.value = wrapped;
    return descriptor;
  };
}
