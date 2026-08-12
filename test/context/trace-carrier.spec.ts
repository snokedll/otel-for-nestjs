import { describe, it, expect, vi, afterEach } from 'vitest';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { captureTraceCarrier, runWithTraceCarrier } from '../../src/context/trace-carrier';
import { runWithRemoteParent } from '../../src/context/w3c-propagation';
import { TraceContextManager } from '../../src/context/trace-context';
import { createFakeTracer } from '../support/otel-mocks';

const VALID_TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const VALID_SPAN_ID = '00f067aa0ba902b7';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('captureTraceCarrier', () => {
  it('returns an empty object when there is no active trace or correlation id', () => {
    expect(captureTraceCarrier()).toEqual({});
  });

  it('captures the traceparent of the active span', () => {
    const remote = { traceId: VALID_TRACE_ID, spanId: VALID_SPAN_ID, traceFlags: 1 };
    const carrier = runWithRemoteParent(remote, () => captureTraceCarrier());
    expect(carrier.traceparent).toContain(VALID_TRACE_ID);
    expect(carrier.traceparent).toContain(VALID_SPAN_ID);
  });

  it('captures the current correlation id', () => {
    const context = TraceContextManager.createContext({ correlationId: 'corr-capture' });
    const carrier = TraceContextManager.run(context, () => captureTraceCarrier());
    expect(carrier.correlationId).toBe('corr-capture');
  });

  it('omits correlationId when none is set', () => {
    const context = TraceContextManager.createContext();
    const carrier = TraceContextManager.run(context, () => captureTraceCarrier());
    expect(carrier.correlationId).toBeUndefined();
  });
});

describe('runWithTraceCarrier', () => {
  it('continues the same trace id captured earlier', () => {
    const remote = { traceId: VALID_TRACE_ID, spanId: VALID_SPAN_ID, traceFlags: 1 };
    const carrier = runWithRemoteParent(remote, () => captureTraceCarrier());

    const observedTraceId = runWithTraceCarrier(carrier, () => trace.getActiveSpan()?.spanContext().traceId);

    expect(observedTraceId).toBe(VALID_TRACE_ID);
  });

  it('exposes the captured correlation id to fn via TraceContextManager', () => {
    const context = TraceContextManager.createContext({ correlationId: 'corr-run' });
    const carrier = TraceContextManager.run(context, () => captureTraceCarrier());

    const observed = runWithTraceCarrier(carrier, () => TraceContextManager.getCorrelationId());

    expect(observed).toBe('corr-run');
  });

  it('still runs fn, as the root of a fresh trace, when carrier is undefined', () => {
    const result = runWithTraceCarrier(undefined, () => 'ran');
    expect(result).toBe('ran');
  });

  it('still runs fn when carrier has no traceparent', () => {
    const result = runWithTraceCarrier({}, () => 'ran');
    expect(result).toBe('ran');
  });

  it('does not throw and still runs fn for a malformed traceparent', () => {
    const result = runWithTraceCarrier({ traceparent: 'not-a-real-traceparent' }, () => 'ran');
    expect(result).toBe('ran');
  });

  it('propagates the synchronous return value', () => {
    expect(runWithTraceCarrier(undefined, () => 42)).toBe(42);
  });

  it('propagates the resolved value for an async fn', async () => {
    await expect(runWithTraceCarrier(undefined, async () => 'async-value')).resolves.toBe('async-value');
  });

  it('rethrows a synchronous error from fn', () => {
    expect(() =>
      runWithTraceCarrier(undefined, () => {
        throw new Error('sync failure');
      }),
    ).toThrow('sync failure');
  });

  it('rejects with the original error for an async fn', async () => {
    await expect(
      runWithTraceCarrier(undefined, async () => {
        throw new Error('async failure');
      }),
    ).rejects.toThrow('async failure');
  });

  describe('span lifecycle', () => {
    function mockTracer() {
      const tracer = createFakeTracer();
      vi.spyOn(trace, 'getTracer').mockReturnValue(tracer);
      return tracer;
    }

    it('starts a span named "async.process" by default', () => {
      const tracer = mockTracer();
      runWithTraceCarrier(undefined, () => 'ok');
      expect(tracer.startActiveSpan).toHaveBeenCalledWith('async.process', expect.any(Object), expect.any(Function));
    });

    it('honors a custom span name and attributes', () => {
      const tracer = mockTracer();
      runWithTraceCarrier(undefined, () => 'ok', { spanName: 'invoice.delayed-processing', attributes: { invoiceId: 'inv_1' } });
      expect(tracer.startActiveSpan).toHaveBeenCalledWith(
        'invoice.delayed-processing',
        { attributes: { invoiceId: 'inv_1' } },
        expect.any(Function),
      );
    });

    it('ends the span OK on success', () => {
      const tracer = mockTracer();
      runWithTraceCarrier(undefined, () => 'ok');
      expect(tracer.spans[0].ended).toBe(true);
      expect(tracer.spans[0].status).toEqual({ code: SpanStatusCode.OK });
    });

    it('records the exception and ends the span with an error status on failure', () => {
      const tracer = mockTracer();
      expect(() =>
        runWithTraceCarrier(undefined, () => {
          throw new Error('boom');
        }),
      ).toThrow('boom');
      expect(tracer.spans[0].ended).toBe(true);
      expect(tracer.spans[0].status?.code).toBe(SpanStatusCode.ERROR);
      expect(tracer.spans[0].exceptions).toHaveLength(1);
    });
  });
});
