import { describe, it, expect } from 'vitest';
import { trace, context as otelContext, isSpanContextValid } from '@opentelemetry/api';
import { extractW3CSpanContext, injectW3CTraceParent, runWithRemoteParent } from '../../src/context/w3c-propagation';

const VALID_TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const VALID_SPAN_ID = '00f067aa0ba902b7';

describe('extractW3CSpanContext', () => {
  it('extracts a valid traceparent header', () => {
    const spanContext = extractW3CSpanContext({
      traceparent: `00-${VALID_TRACE_ID}-${VALID_SPAN_ID}-01`,
    });

    expect(spanContext).toBeDefined();
    expect(spanContext?.traceId).toBe(VALID_TRACE_ID);
    expect(spanContext?.spanId).toBe(VALID_SPAN_ID);
    expect(isSpanContextValid(spanContext!)).toBe(true);
  });

  it('returns undefined when no traceparent header is present', () => {
    expect(extractW3CSpanContext({})).toBeUndefined();
  });

  it('returns undefined for a malformed traceparent header', () => {
    expect(extractW3CSpanContext({ traceparent: 'not-a-real-traceparent' })).toBeUndefined();
  });

  it('rejects the all-zero sentinel trace id', () => {
    const spanContext = extractW3CSpanContext({ traceparent: `00-${'0'.repeat(32)}-${VALID_SPAN_ID}-01` });
    expect(spanContext === undefined || !isSpanContextValid(spanContext)).toBe(true);
  });

  it('reads the first value of a multi-valued header', () => {
    const spanContext = extractW3CSpanContext({
      traceparent: [`00-${VALID_TRACE_ID}-${VALID_SPAN_ID}-01`, `00-${'f'.repeat(32)}-${'e'.repeat(16)}-01`],
    });
    expect(spanContext?.traceId).toBe(VALID_TRACE_ID);
  });
});

describe('injectW3CTraceParent', () => {
  it('injects nothing when there is no active span', () => {
    const carrier: Record<string, string> = {};
    injectW3CTraceParent(carrier);
    expect(carrier.traceparent).toBeUndefined();
  });

  it('injects the active span context as a traceparent header', () => {
    const remote = { traceId: VALID_TRACE_ID, spanId: VALID_SPAN_ID, traceFlags: 1 };

    runWithRemoteParent(remote, () => {
      const carrier: Record<string, string> = {};
      injectW3CTraceParent(carrier);
      expect(carrier.traceparent).toContain(VALID_TRACE_ID);
      expect(carrier.traceparent).toContain(VALID_SPAN_ID);
    });
  });
});

describe('runWithRemoteParent', () => {
  it('makes the remote span context active for the duration of fn', () => {
    const remote = { traceId: VALID_TRACE_ID, spanId: VALID_SPAN_ID, traceFlags: 1 };

    const observedTraceId = runWithRemoteParent(remote, () => trace.getActiveSpan()?.spanContext().traceId);

    expect(observedTraceId).toBe(VALID_TRACE_ID);
  });

  it('does not leak the remote context outside of fn', () => {
    const remote = { traceId: VALID_TRACE_ID, spanId: VALID_SPAN_ID, traceFlags: 1 };

    runWithRemoteParent(remote, () => {});

    expect(otelContext.active()).toBe(otelContext.active());
    expect(trace.getSpanContext(otelContext.active())).toBeUndefined();
  });

  it('propagates the return value, including for async functions', async () => {
    const remote = { traceId: VALID_TRACE_ID, spanId: VALID_SPAN_ID, traceFlags: 1 };
    const result = await runWithRemoteParent(remote, async () => 'done');
    expect(result).toBe('done');
  });
});
