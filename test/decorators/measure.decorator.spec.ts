import 'reflect-metadata';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { metrics } from '@opentelemetry/api';
import { Measure, type MeasureOptions } from '../../src/decorators/measure.decorator';
import { createFakeMeter } from '../support/otel-mocks';

function mockMeter() {
  const meter = createFakeMeter();
  vi.spyOn(metrics, 'getMeter').mockReturnValue(meter as never);
  return meter;
}

afterEach(() => {
  vi.restoreAllMocks();
});

let seq = 0;
class Sample {
  syncOk(value: number): number {
    return value * 2;
  }

  syncThrow(): never {
    throw new Error('sync failure');
  }

  async asyncOk(): Promise<string> {
    return 'ok';
  }

  async asyncThrow(): Promise<never> {
    throw new Error('async failure');
  }
}

function applyMeasure(methodName: keyof Sample, options?: MeasureOptions | string) {
  seq += 1;
  const original = Object.getOwnPropertyDescriptor(Sample.prototype, methodName)!;
  const resolvedOptions = typeof options === 'string' ? options : { name: `Sample.${methodName}.${seq}`, ...options };
  const decorated = Measure(resolvedOptions)(Sample.prototype, methodName, { ...original });
  return decorated.value as (...args: unknown[]) => unknown;
}

describe('@Measure', () => {
  it('creates a `<name>.calls` counter and a `<name>.duration` histogram, resolved on first call — not at decoration time', () => {
    const meter = mockMeter();
    const wrapped = applyMeasure('syncOk', 'payment.process');

    // Not yet: decoration alone must not touch the Metrics API. Decoration
    // runs at class-load time, which can happen before initializeTelemetry()
    // does (see claude.md) — resolving eagerly here would silently bind to
    // whatever (possibly noop) MeterProvider is active at that moment.
    expect(meter.createCounter).not.toHaveBeenCalled();
    expect(meter.createHistogram).not.toHaveBeenCalled();

    wrapped(1);

    expect(meter.createCounter).toHaveBeenCalledWith('payment.process.calls', expect.objectContaining({ description: expect.any(String) }));
    expect(meter.createHistogram).toHaveBeenCalledWith(
      'payment.process.duration',
      expect.objectContaining({ description: expect.any(String), unit: 'ms' }),
    );
  });

  it('records a success outcome and returns the original value', () => {
    const meter = mockMeter();
    const wrapped = applyMeasure('syncOk', 'm.sync-ok');

    const result = wrapped(21);

    expect(result).toBe(42);
    const counter = meter.created['counter:m.sync-ok.calls'] as { add: ReturnType<typeof vi.fn> };
    const histogram = meter.created['histogram:m.sync-ok.duration'] as { record: ReturnType<typeof vi.fn> };
    expect(counter.add).toHaveBeenCalledWith(1, expect.objectContaining({ outcome: 'success' }));
    expect(histogram.record).toHaveBeenCalledWith(expect.any(Number), expect.objectContaining({ outcome: 'success' }));
  });

  it('records an error outcome and rethrows', () => {
    const meter = mockMeter();
    const wrapped = applyMeasure('syncThrow', 'm.sync-throw');

    expect(() => wrapped()).toThrow('sync failure');
    const counter = meter.created['counter:m.sync-throw.calls'] as { add: ReturnType<typeof vi.fn> };
    expect(counter.add).toHaveBeenCalledWith(1, expect.objectContaining({ outcome: 'error' }));
  });

  it('records a success outcome for a resolved async method', async () => {
    const meter = mockMeter();
    const wrapped = applyMeasure('asyncOk', 'm.async-ok');

    await expect(wrapped()).resolves.toBe('ok');
    const counter = meter.created['counter:m.async-ok.calls'] as { add: ReturnType<typeof vi.fn> };
    expect(counter.add).toHaveBeenCalledWith(1, expect.objectContaining({ outcome: 'success' }));
  });

  it('records an error outcome for a rejected async method', async () => {
    const meter = mockMeter();
    const wrapped = applyMeasure('asyncThrow', 'm.async-throw');

    await expect(wrapped()).rejects.toThrow('async failure');
    const counter = meter.created['counter:m.async-throw.calls'] as { add: ReturnType<typeof vi.fn> };
    expect(counter.add).toHaveBeenCalledWith(1, expect.objectContaining({ outcome: 'error' }));
  });

  it('merges configured base attributes into every recorded call', () => {
    const meter = mockMeter();
    const wrapped = applyMeasure('syncOk', { name: 'm.with-attrs', attributes: { tenant: 'acme' } });

    wrapped(1);

    const counter = meter.created['counter:m.with-attrs.calls'] as { add: ReturnType<typeof vi.fn> };
    expect(counter.add).toHaveBeenCalledWith(1, { tenant: 'acme', outcome: 'success' });
  });

  it('uses whichever MeterProvider is active at call time, not at decoration time', () => {
    // Regression test: decoration can happen before initializeTelemetry()
    // runs (any class transitively imported ahead of AppModule's own
    // @Module() decorator, since TelemetryModule.forRoot() is the SDK's
    // sole entry point — see claude.md). A noop meter active AT DECORATION
    // TIME must not get baked in; only the meter active at CALL time matters.
    const noopMeter = mockMeter();
    const wrapped = applyMeasure('syncOk', 'm.late-init');
    expect(noopMeter.createCounter).not.toHaveBeenCalled();

    const realMeter = mockMeter();
    wrapped(1);

    expect(noopMeter.createCounter).not.toHaveBeenCalled();
    expect(realMeter.createCounter).toHaveBeenCalledWith('m.late-init.calls', expect.any(Object));
  });

  it('rejects a symbol-keyed property', () => {
    expect(() => Measure()(Sample.prototype, Symbol('sym'), { value: () => {} })).toThrow(/string name/);
  });

  it('preserves Function.prototype.name on the wrapper (Nest ExecutionContext.getHandler().name reads it)', () => {
    mockMeter();
    const wrapped = applyMeasure('syncOk', 'm.name-check');
    expect(wrapped.name).toBe('syncOk');
  });

  describe('decoration-order independence', () => {
    it('preserves metadata already attached before @Measure runs', () => {
      const original = Object.getOwnPropertyDescriptor(Sample.prototype, 'syncOk')!;
      Reflect.defineMetadata('eventPattern', 'invoice.created', original.value);
      mockMeter();

      const wrapped = Measure({ name: 'm.metadata-order' })(Sample.prototype, 'syncOk', { ...original }).value as (
        ...args: unknown[]
      ) => unknown;

      expect(Reflect.getMetadata('eventPattern', wrapped)).toBe('invoice.created');
    });
  });
});
