import { describe, it, expect, vi, afterEach } from 'vitest';
import { metrics } from '@opentelemetry/api';
import { MetricsService } from '../../src/metrics/metrics.service';
import { createFakeMeter } from '../support/otel-mocks';

function mockMeter() {
  const meter = createFakeMeter();
  vi.spyOn(metrics, 'getMeter').mockReturnValue(meter as never);
  return meter;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MetricsService', () => {
  describe('counter', () => {
    it('does not touch the Metrics API until .add() is actually called', () => {
      const meter = mockMeter();

      MetricsService.counter('unique.counter.a', { description: 'desc', unit: 'unit' });

      expect(meter.createCounter).not.toHaveBeenCalled();
    });

    it('creates a counter on the shared meter on first .add()', () => {
      const meter = mockMeter();

      const counter = MetricsService.counter('unique.counter.a', { description: 'desc', unit: 'unit' });
      counter.add(1);

      expect(meter.createCounter).toHaveBeenCalledWith('unique.counter.a', { description: 'desc', unit: 'unit' });
    });

    it('caches by name: a second call with the same name does not create a new underlying instrument', () => {
      const meter = mockMeter();

      const first = MetricsService.counter('unique.counter.b');
      const second = MetricsService.counter('unique.counter.b');
      first.add(1);
      second.add(1);

      expect(meter.createCounter).toHaveBeenCalledTimes(1);
      const raw = meter.created['counter:unique.counter.b'] as { add: ReturnType<typeof vi.fn> };
      expect(raw.add).toHaveBeenCalledTimes(2);
    });

    it('merges base attributes from options into every .add() call, preserving the caller\'s original argument count', () => {
      const meter = mockMeter();

      const counter = MetricsService.counter('unique.counter.c', { attributes: { module: 'invoices' } });
      counter.add(1, { outcome: 'success' });

      const raw = meter.created['counter:unique.counter.c'] as { add: ReturnType<typeof vi.fn> };
      expect(raw.add).toHaveBeenCalledWith(1, { module: 'invoices', outcome: 'success' });
    });

    it('lets per-call attributes win over base attributes on key collision', () => {
      const meter = mockMeter();

      const counter = MetricsService.counter('unique.counter.d', { attributes: { outcome: 'unknown' } });
      counter.add(1, { outcome: 'success' });

      const raw = meter.created['counter:unique.counter.d'] as { add: ReturnType<typeof vi.fn> };
      expect(raw.add).toHaveBeenCalledWith(1, { outcome: 'success' });
    });

    it('forwards a call with no attributes at all as a single-argument call, no attributes object introduced', () => {
      const meter = mockMeter();

      const counter = MetricsService.counter('unique.counter.e');
      counter.add(1);

      const raw = meter.created['counter:unique.counter.e'] as { add: ReturnType<typeof vi.fn> };
      expect(raw.add).toHaveBeenCalledWith(1);
    });
  });

  describe('histogram', () => {
    it('does not touch the Metrics API until .record() is actually called', () => {
      const meter = mockMeter();

      MetricsService.histogram('unique.histogram.a', { description: 'desc', unit: 'ms' });

      expect(meter.createHistogram).not.toHaveBeenCalled();
    });

    it('creates a histogram on the shared meter on first .record()', () => {
      const meter = mockMeter();

      const histogram = MetricsService.histogram('unique.histogram.a', { description: 'desc', unit: 'ms' });
      histogram.record(42);

      expect(meter.createHistogram).toHaveBeenCalledWith('unique.histogram.a', { description: 'desc', unit: 'ms' });
    });

    it('merges base attributes from options into every .record() call', () => {
      const meter = mockMeter();

      const histogram = MetricsService.histogram('unique.histogram.b', { attributes: { module: 'invoices' } });
      histogram.record(42, { outcome: 'success' });

      const raw = meter.created['histogram:unique.histogram.b'] as { record: ReturnType<typeof vi.fn> };
      expect(raw.record).toHaveBeenCalledWith(42, { module: 'invoices', outcome: 'success' });
    });
  });

  describe('upDownCounter', () => {
    it('does not touch the Metrics API until .add() is actually called', () => {
      const meter = mockMeter();

      MetricsService.upDownCounter('unique.updown.a');

      expect(meter.createUpDownCounter).not.toHaveBeenCalled();
    });

    it('creates an up-down counter on the shared meter on first .add()', () => {
      const meter = mockMeter();

      const upDownCounter = MetricsService.upDownCounter('unique.updown.a');
      upDownCounter.add(1);

      expect(meter.createUpDownCounter).toHaveBeenCalledWith('unique.updown.a', { description: undefined, unit: undefined });
    });

    it('merges base attributes from options into every .add() call', () => {
      const meter = mockMeter();

      const upDownCounter = MetricsService.upDownCounter('unique.updown.b', { attributes: { queue: 'invoices' } });
      upDownCounter.add(-1);

      const raw = meter.created['upDownCounter:unique.updown.b'] as { add: ReturnType<typeof vi.fn> };
      expect(raw.add).toHaveBeenCalledWith(-1, { queue: 'invoices' });
    });
  });

  describe('observableGauge', () => {
    it('registers against the current meter immediately — not deferred like the other factories', () => {
      const meter = mockMeter();
      const callback = vi.fn();

      MetricsService.observableGauge('unique.gauge.a', callback, { description: 'desc' });

      expect(meter.createObservableGauge).toHaveBeenCalledWith('unique.gauge.a', { description: 'desc', unit: undefined });
      const gauge = meter.created['observableGauge:unique.gauge.a'] as { addCallback: ReturnType<typeof vi.fn> };
      expect(gauge.addCallback).toHaveBeenCalledWith(expect.any(Function));
    });

    it('merges base attributes into every result.observe() call made by the callback', () => {
      const meter = mockMeter();
      const observe = vi.fn();

      MetricsService.observableGauge('unique.gauge.b', (result) => result.observe(3, { status: 'pending' }), {
        attributes: { module: 'invoices' },
      });

      const gauge = meter.created['observableGauge:unique.gauge.b'] as { addCallback: ReturnType<typeof vi.fn> };
      const registeredCallback = gauge.addCallback.mock.calls[0][0] as (result: { observe: typeof observe }) => void;
      registeredCallback({ observe });

      expect(observe).toHaveBeenCalledWith(3, { module: 'invoices', status: 'pending' });
    });
  });

  it('resolves the meter freshly on every recorded value, never caching a stale provider reference', () => {
    const meterA = createFakeMeter();
    vi.spyOn(metrics, 'getMeter').mockReturnValueOnce(meterA as never);
    MetricsService.counter('unique.fresh.a').add(1);

    const meterB = createFakeMeter();
    vi.spyOn(metrics, 'getMeter').mockReturnValueOnce(meterB as never);
    MetricsService.counter('unique.fresh.b').add(1);

    expect(meterA.createCounter).toHaveBeenCalledWith('unique.fresh.a', expect.anything());
    expect(meterB.createCounter).toHaveBeenCalledWith('unique.fresh.b', expect.anything());
    expect(meterA.createCounter).not.toHaveBeenCalledWith('unique.fresh.b', expect.anything());
  });

  it('uses whichever MeterProvider is active when .add() is called, not whichever was active when counter() was called', () => {
    // Regression test for the general MetricsService timing hazard: a noop
    // meter active when MetricsService.counter() itself is invoked (module
    // scope, a class field initializer, before initializeTelemetry() runs)
    // must never get baked in — only the meter active at the first .add()
    // call matters. See claude.md.
    const noopMeter = mockMeter();
    const counter = MetricsService.counter('unique.late-init.a');
    expect(noopMeter.createCounter).not.toHaveBeenCalled();

    const realMeter = mockMeter();
    counter.add(1);

    expect(noopMeter.createCounter).not.toHaveBeenCalled();
    expect(realMeter.createCounter).toHaveBeenCalledWith('unique.late-init.a', expect.any(Object));
  });
});
