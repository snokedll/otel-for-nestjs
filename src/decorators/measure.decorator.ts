import { MetricsService, type MetricAttributes } from '../metrics/metrics.service';
import { assertStringPropertyKey, preserveFunctionName, resolveDefaultName } from './decorator-utils';
import { copyMethodMetadata } from './copy-method-metadata';
import { settleSyncOrAsync } from './settle-sync-or-async';

export interface MeasureOptions {
  /** Base metric name. Defaults to `ClassName.methodName`. Produces `<name>.calls` and `<name>.duration`. */
  name?: string;
  /** Fixed attributes added to every recorded call — keep low-cardinality, see {@link MetricsService}. */
  attributes?: MetricAttributes;
}

function resolveMeasureOptions(options?: MeasureOptions | string): MeasureOptions {
  return typeof options === 'string' ? { name: options } : (options ?? {});
}

/**
 * Wraps a method (sync or async), recording a `<name>.calls` counter and a
 * `<name>.duration` histogram (milliseconds) on every invocation, tagged
 * with `outcome: 'success' | 'error'`. Pairs well with {@link Span} —
 * the trace gives the detailed per-call sample, the metric gives the cheap,
 * long-retention aggregate.
 *
 * @param options a metric name, or {@link MeasureOptions}.
 *
 * @example
 * ```ts
 * class PaymentService {
 *   @Measure('payment.process')
 *   async processPayment(orderId: string) { ... }
 * }
 * ```
 */
export function Measure(options?: MeasureOptions | string): MethodDecorator {
  const measureOptions = resolveMeasureOptions(options);

  return (target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor): PropertyDescriptor => {
    assertStringPropertyKey(propertyKey, '@Measure');

    const originalMethod = descriptor.value as (...args: unknown[]) => unknown;
    const measureName = measureOptions.name ?? resolveDefaultName(target, propertyKey);
    const baseAttributes = measureOptions.attributes ?? {};

    // Resolved on every call, NOT once here at decoration time: decoration
    // runs the moment this class is `require()`d, which — since
    // `TelemetryModule.forRoot()` is the SDK's sole entry point and only
    // runs once `AppModule` itself starts loading — can happen before
    // `initializeTelemetry()` ever does, for any class transitively
    // imported ahead of `AppModule`'s own `@Module()` decorator (see
    // claude.md). `MetricsService`'s own name-keyed cache makes resolving
    // on every call cheap after the first real one, the same tradeoff
    // `@Span()` already makes with `trace.getTracer()`.
    const record = (startTime: number, outcome: 'success' | 'error'): void => {
      const attributes = { ...baseAttributes, outcome };
      const callsCounter = MetricsService.counter(`${measureName}.calls`, { description: `Total calls to ${measureName}` });
      const durationHistogram = MetricsService.histogram(`${measureName}.duration`, {
        description: `Duration of ${measureName}`,
        unit: 'ms',
      });
      durationHistogram.record(performance.now() - startTime, attributes);
      callsCounter.add(1, attributes);
    };

    const wrapped = function (this: unknown, ...args: unknown[]): unknown {
      const startTime = performance.now();

      return settleSyncOrAsync(
        () => originalMethod.apply(this, args),
        (value) => {
          record(startTime, 'success');
          return value;
        },
        (error) => {
          record(startTime, 'error');
          throw error;
        },
      );
    };

    copyMethodMetadata(originalMethod, wrapped);
    preserveFunctionName(originalMethod, wrapped);
    descriptor.value = wrapped;
    return descriptor;
  };
}
