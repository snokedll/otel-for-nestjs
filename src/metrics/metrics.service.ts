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
 * Wraps an already-created counter/up-down-counter so every `.add()` call
 * merges in `base` — the instrument itself is still the one cached by
 * {@link InstrumentCache}, so this only changes what each call site sees.
 */
function bindAddInstrument<T extends { add(value: number, attributes?: MetricAttributes, context?: Context): void }>(
  instrument: T,
  base: MetricAttributes | undefined,
): T {
  if (!base) return instrument;
  return { add: (value, attributes, context) => instrument.add(value, mergeAttributes(base, attributes), context) } as T;
}

/** Wraps an already-created histogram so every `.record()` call merges in `base`. */
function bindHistogram(instrument: Histogram, base: MetricAttributes | undefined): Histogram {
  if (!base) return instrument;
  return { record: (value, attributes, context) => instrument.record(value, mergeAttributes(base, attributes), context) };
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
 * identity model for a `Meter`: calling a factory again with the same
 * `name` returns the same underlying instrument, and `description`/`unit`/
 * `attributes` from the *first* call are the ones that take effect.
 */
export class MetricsService {
  /** A monotonically increasing counter — request counts, items created, messages processed. */
  static counter(name: string, options?: MetricOptions): Counter {
    const instrument = counters.resolve(name, () =>
      getMeter().createCounter(name, { description: options?.description, unit: options?.unit }),
    );
    return bindAddInstrument(instrument, options?.attributes);
  }

  /** A distribution of recorded values — request/processing duration, payload size. */
  static histogram(name: string, options?: MetricOptions): Histogram {
    const instrument = histograms.resolve(name, () =>
      getMeter().createHistogram(name, { description: options?.description, unit: options?.unit }),
    );
    return bindHistogram(instrument, options?.attributes);
  }

  /** A counter that can both increase and decrease — active connections, queue depth. */
  static upDownCounter(name: string, options?: MetricOptions): UpDownCounter {
    const instrument = upDownCounters.resolve(name, () =>
      getMeter().createUpDownCounter(name, { description: options?.description, unit: options?.unit }),
    );
    return bindAddInstrument(instrument, options?.attributes);
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
   * DI may construct the owning provider more than once in tests.
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
