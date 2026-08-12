import { describe, it, expect, vi, afterEach } from 'vitest';
import { metrics } from '@opentelemetry/api';
import { MetricsService } from '../../src/metrics/metrics.service';
import { createFakeMeter } from '../support/otel-mocks';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MetricsService', () => {
  describe('counter', () => {
    it('creates a counter on the shared meter', () => {
      const meter = createFakeMeter();
      vi.spyOn(metrics, 'getMeter').mockReturnValue(meter as never);

      const counter = MetricsService.counter('unique.counter.a', { description: 'desc', unit: 'unit' });

      expect(meter.createCounter).toHaveBeenCalledWith('unique.counter.a', { description: 'desc', unit: 'unit' });
      expect(counter).toBe(meter.created['counter:unique.counter.a']);
    });

    it('caches by name: a second call with the same name does not create a new instrument', () => {
      const meter = createFakeMeter();
      vi.spyOn(metrics, 'getMeter').mockReturnValue(meter as never);

      const first = MetricsService.counter('unique.counter.b');
      const second = MetricsService.counter('unique.counter.b');

      expect(first).toBe(second);
      expect(meter.createCounter).toHaveBeenCalledTimes(1);
    });

    it('merges base attributes from options into every .add() call', () => {
      const meter = createFakeMeter();
      vi.spyOn(metrics, 'getMeter').mockReturnValue(meter as never);

      const counter = MetricsService.counter('unique.counter.c', { attributes: { module: 'invoices' } });
      counter.add(1, { outcome: 'success' });

      const raw = meter.created['counter:unique.counter.c'] as { add: ReturnType<typeof vi.fn> };
      expect(raw.add).toHaveBeenCalledWith(1, { module: 'invoices', outcome: 'success' }, undefined);
    });

    it('lets per-call attributes win over base attributes on key collision', () => {
      const meter = createFakeMeter();
      vi.spyOn(metrics, 'getMeter').mockReturnValue(meter as never);

      const counter = MetricsService.counter('unique.counter.d', { attributes: { outcome: 'unknown' } });
      counter.add(1, { outcome: 'success' });

      const raw = meter.created['counter:unique.counter.d'] as { add: ReturnType<typeof vi.fn> };
      expect(raw.add).toHaveBeenCalledWith(1, { outcome: 'success' }, undefined);
    });
  });

  describe('histogram', () => {
    it('creates a histogram on the shared meter', () => {
      const meter = createFakeMeter();
      vi.spyOn(metrics, 'getMeter').mockReturnValue(meter as never);

      MetricsService.histogram('unique.histogram.a', { description: 'desc', unit: 'ms' });

      expect(meter.createHistogram).toHaveBeenCalledWith('unique.histogram.a', { description: 'desc', unit: 'ms' });
    });

    it('merges base attributes from options into every .record() call', () => {
      const meter = createFakeMeter();
      vi.spyOn(metrics, 'getMeter').mockReturnValue(meter as never);

      const histogram = MetricsService.histogram('unique.histogram.b', { attributes: { module: 'invoices' } });
      histogram.record(42, { outcome: 'success' });

      const raw = meter.created['histogram:unique.histogram.b'] as { record: ReturnType<typeof vi.fn> };
      expect(raw.record).toHaveBeenCalledWith(42, { module: 'invoices', outcome: 'success' }, undefined);
    });
  });

  describe('upDownCounter', () => {
    it('creates an up-down counter on the shared meter', () => {
      const meter = createFakeMeter();
      vi.spyOn(metrics, 'getMeter').mockReturnValue(meter as never);

      MetricsService.upDownCounter('unique.updown.a');

      expect(meter.createUpDownCounter).toHaveBeenCalledWith('unique.updown.a', { description: undefined, unit: undefined });
    });

    it('merges base attributes from options into every .add() call', () => {
      const meter = createFakeMeter();
      vi.spyOn(metrics, 'getMeter').mockReturnValue(meter as never);

      const upDownCounter = MetricsService.upDownCounter('unique.updown.b', { attributes: { queue: 'invoices' } });
      upDownCounter.add(-1);

      const raw = meter.created['upDownCounter:unique.updown.b'] as { add: ReturnType<typeof vi.fn> };
      expect(raw.add).toHaveBeenCalledWith(-1, { queue: 'invoices' }, undefined);
    });
  });

  describe('observableGauge', () => {
    it('creates the gauge and registers the callback', () => {
      const meter = createFakeMeter();
      vi.spyOn(metrics, 'getMeter').mockReturnValue(meter as never);
      const callback = vi.fn();

      MetricsService.observableGauge('unique.gauge.a', callback, { description: 'desc' });

      const gauge = meter.created['observableGauge:unique.gauge.a'] as { addCallback: ReturnType<typeof vi.fn> };
      expect(gauge.addCallback).toHaveBeenCalledWith(expect.any(Function));
    });

    it('merges base attributes into every result.observe() call made by the callback', () => {
      const meter = createFakeMeter();
      vi.spyOn(metrics, 'getMeter').mockReturnValue(meter as never);
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

  it('resolves the meter freshly on every call, never caching a stale provider reference', () => {
    const meterA = createFakeMeter();
    vi.spyOn(metrics, 'getMeter').mockReturnValueOnce(meterA as never);
    MetricsService.counter('unique.fresh.a');

    const meterB = createFakeMeter();
    vi.spyOn(metrics, 'getMeter').mockReturnValueOnce(meterB as never);
    MetricsService.counter('unique.fresh.b');

    expect(meterA.createCounter).toHaveBeenCalledWith('unique.fresh.a', expect.anything());
    expect(meterB.createCounter).toHaveBeenCalledWith('unique.fresh.b', expect.anything());
    expect(meterA.createCounter).not.toHaveBeenCalledWith('unique.fresh.b', expect.anything());
  });
});
