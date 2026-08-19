import {
  metrics,
  type Context,
  type Counter,
  type Histogram,
  type UpDownCounter,
  type Attributes,
  type ObservableCallback,
  type ObservableGauge,
} from '@opentelemetry/api';

export type MetricAttributes = Attributes;

/**
 * Options accepted by every {@link MetricsService} factory method.
 *
 * `attributes` is merged into every `.add()`/`.record()` call made through
 * the returned instrument — useful to permanently link a metric to a fixed
 * piece of context (a tenant, a queue name, a worker id) without repeating
 * it at every call site. Per-call attributes win when a key collides.
 *
 * Keep it low-cardinality just like any other metric attribute — see the
 * class-level documentation.
 */
export interface MetricOptions {
  description?: string;
  unit?: string;
  attributes?: MetricAttributes;
}

const METER_NAME = '@snokedll/otel-for-nestjs';

/**
 * Resolves the current global `Meter`. Intentionally never cached at
 * module scope: the Metrics API resolves the active `MeterProvider` at
 * call time, and a reference captured before `initializeTelemetry()` runs
 * would be permanently bound to a no-op meter.
 */
function getMeter(): ReturnType<typeof metrics.getMeter> {
  return metrics.getMeter(METER_NAME);
}

/** Factory-with-cache for a single instrument kind, keyed by instrument name. */
class InstrumentCache<TInstrument> {
  private readonly instruments = new Map<string, TInstrument>();

  /** @returns the cached instrument for `name`, creating it via `create` on first use. */
  resolve(name: string, create: () => TInstrument): TInstrument {
    const existing = this.instruments.get(name);
    if (existing) return existing;

    const created = create();
    this.instruments.set(name, created);
    return created;
  }
}

const counters = new InstrumentCache<Counter>();
const histograms = new InstrumentCache<Histogram>();
const upDownCounters = new InstrumentCache<UpDownCounter>();

function mergeAttributes(base: MetricAttributes | undefined, attributes: MetricAttributes | undefined): MetricAttributes | undefined {
  if (!base) return attributes;
  if (!attributes) return base;
  return { ...base, ...attributes };
}

/**
 * Calls `invoke` (the resolved instrument's own `.add()`/`.record()`) with
 * `base` merged into whatever attributes the caller passed — forwarding
 * `args` exactly as received (same length, same `context` presence/absence)
 * whenever there is no `base` to merge in, so a caller that never passes
 * `context` never sees one appear in the underlying call.
 */
function recordValue(
  invoke: (...args: [value: number, attributes?: MetricAttributes, context?: Context]) => void,
  base: MetricAttributes | undefined,
  args: [value: number, attributes?: MetricAttributes, context?: Context],
): void {
  if (!base) {
    invoke(...args);
    return;
  }
  const [value, attributes, context] = args;
  const merged = mergeAttributes(base, attributes);
  if (args.length >= 3) invoke(value, merged, context);
  else invoke(value, merged);
}

/**
 * Creates and caches OpenTelemetry instruments on a single shared `Meter`.
 *
 * Metric attributes must stay low-cardinality (`method`, `route`,
 * `status_code`, `topic`, `outcome`, ...) — never a per-call-unique value
 * such as a trace ID or a business entity ID, each distinct attribute
 * combination becomes its own time series in the metrics backend.
 * Correlating a metric to the trace that produced it is done via
 * exemplars (automatic whenever a valid span is active at `add`/`record`
 * time), not attributes.
 *
 * Instruments are cached by name only, matching OpenTelemetry's own
 * identity model for a `Meter`: recording a value again with the same
 * `name` targets the same underlying instrument, and `description`/`unit`/
 * `attributes` from the *first* recorded value are the ones that take
 * effect.
 *
 * Every factory below is safe to call at ANY time — module load, a class
 * field initializer, inside a decorator, before or after
 * `initializeTelemetry()` has run — because the underlying instrument
 * isn't actually resolved until the returned handle's `.add()`/`.record()`
 * is invoked, and resolves fresh (via the same name-keyed cache) every
 * time. Whichever `MeterProvider` is active AT THAT POINT — always the
 * real one, in practice, since recording only happens once actual traffic
 * flows — is the one that gets used.
 */
export class MetricsService {
  /** A monotonically increasing counter — request counts, items created, messages processed. */
  static counter(name: string, options?: MetricOptions): Counter {
    const base = options?.attributes;
    return {
      add: (...args: [value: number, attributes?: MetricAttributes, context?: Context]): void => {
        const instrument = counters.resolve(name, () =>
          getMeter().createCounter(name, { description: options?.description, unit: options?.unit }),
        );
        recordValue((...a) => instrument.add(...a), base, args);
      },
    };
  }

  /** A distribution of recorded values — request/processing duration, payload size. */
  static histogram(name: string, options?: MetricOptions): Histogram {
    const base = options?.attributes;
    return {
      record: (...args: [value: number, attributes?: MetricAttributes, context?: Context]): void => {
        const instrument = histograms.resolve(name, () =>
          getMeter().createHistogram(name, { description: options?.description, unit: options?.unit }),
        );
        recordValue((...a) => instrument.record(...a), base, args);
      },
    };
  }

  /** A counter that can both increase and decrease — active connections, queue depth. */
  static upDownCounter(name: string, options?: MetricOptions): UpDownCounter {
    const base = options?.attributes;
    return {
      add: (...args: [value: number, attributes?: MetricAttributes, context?: Context]): void => {
        const instrument = upDownCounters.resolve(name, () =>
          getMeter().createUpDownCounter(name, { description: options?.description, unit: options?.unit }),
        );
        recordValue((...a) => instrument.add(...a), base, args);
      },
    };
  }

  /**
   * A gauge whose value is pulled from `callback` at collection time
   * rather than pushed per event — for values that already live somewhere
   * (an in-memory collection's size, heap usage) rather than a manually
   * synchronized counter.
   *
   * `options.attributes` is merged into every observation the callback
   * reports via `result.observe(value, attributes)`.
   *
   * Unlike the other factories, this one is not cached by name — an
   * observable instrument's callback is part of its identity, and Nest's
   * DI may construct the owning provider more than once in tests. It also
   * registers against the current `Meter` IMMEDIATELY, unlike
   * `counter()`/`histogram()`/`upDownCounter()` (which defer resolution to
   * the first recorded value) — there is no equivalent "first call" moment
   * to defer to for a pull-based instrument. Call it from a constructor or
   * other instance-scoped code (as every example in this SDK does), never
   * from module scope or from inside a decorator — those run before
   * `initializeTelemetry()` can have started, see claude.md.
   */
  static observableGauge(name: string, callback: ObservableCallback, options?: MetricOptions): ObservableGauge {
    const base = options?.attributes;
    const gauge = getMeter().createObservableGauge(name, { description: options?.description, unit: options?.unit });
    gauge.addCallback((result) => {
      const boundResult = base
        ? { observe: (value: number, attributes?: MetricAttributes) => result.observe(value, mergeAttributes(base, attributes)) }
        : result;
      callback(boundResult as Parameters<ObservableCallback>[0]);
    });
    return gauge;
  }
}
