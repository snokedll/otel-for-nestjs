import { describe, it, expect } from 'vitest';
import { trace } from '@opentelemetry/api';
import { captureTraceCarrier, resumeTraceCarrier } from '../../src/context/trace-carrier';
import { runWithRemoteParent } from '../../src/context/w3c-propagation';
import { TraceContextManager } from '../../src/context/trace-context';

const VALID_TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const VALID_SPAN_ID = '00f067aa0ba902b7';

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

describe('resumeTraceCarrier', () => {
  it('continues the same trace id captured earlier', () => {
    const remote = { traceId: VALID_TRACE_ID, spanId: VALID_SPAN_ID, traceFlags: 1 };
    const carrier = runWithRemoteParent(remote, () => captureTraceCarrier());

    const observedTraceId = resumeTraceCarrier(carrier, () => trace.getActiveSpan()?.spanContext().traceId);

    expect(observedTraceId).toBe(VALID_TRACE_ID);
  });

  it('exposes the captured correlation id to fn via TraceContextManager', () => {
    const context = TraceContextManager.createContext({ correlationId: 'corr-run' });
    const carrier = TraceContextManager.run(context, () => captureTraceCarrier());

    const observed = resumeTraceCarrier(carrier, () => TraceContextManager.getCorrelationId());

    expect(observed).toBe('corr-run');
  });

  it('still runs fn, as the root of a fresh trace, when carrier is undefined', () => {
    const result = resumeTraceCarrier(undefined, () => 'ran');
    expect(result).toBe('ran');
  });

  it('still runs fn when carrier has no traceparent', () => {
    const result = resumeTraceCarrier({}, () => 'ran');
    expect(result).toBe('ran');
  });

  it('does not throw and still runs fn for a malformed traceparent', () => {
    const result = resumeTraceCarrier({ traceparent: 'not-a-real-traceparent' }, () => 'ran');
    expect(result).toBe('ran');
  });

  it('propagates the synchronous return value', () => {
    expect(resumeTraceCarrier(undefined, () => 42)).toBe(42);
  });

  it('propagates the resolved value for an async fn', async () => {
    await expect(resumeTraceCarrier(undefined, async () => 'async-value')).resolves.toBe('async-value');
  });

  it('rethrows a synchronous error from fn', () => {
    expect(() =>
      resumeTraceCarrier(undefined, () => {
        throw new Error('sync failure');
      }),
    ).toThrow('sync failure');
  });

  it('rejects with the original error for an async fn', async () => {
    await expect(
      resumeTraceCarrier(undefined, async () => {
        throw new Error('async failure');
      }),
    ).rejects.toThrow('async failure');
  });

  it('does not create a span of its own — trace.getActiveSpan() stays a non-recording placeholder for the resumed context', () => {
    const remote = { traceId: VALID_TRACE_ID, spanId: VALID_SPAN_ID, traceFlags: 1 };
    const carrier = runWithRemoteParent(remote, () => captureTraceCarrier());

    const observed = resumeTraceCarrier(carrier, () => trace.getActiveSpan()?.spanContext());

    // Same span id as the captured carrier — resumeTraceCarrier only re-parents
    // the ambient context, it never calls startActiveSpan()/creates a new span id.
    expect(observed?.spanId).toBe(VALID_SPAN_ID);
  });
});
