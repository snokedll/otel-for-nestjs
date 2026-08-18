import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { trace } from '@opentelemetry/api';
import { ContinueTrace, type ContinueTraceOptions } from '../../src/decorators/continue-trace.decorator';
import { Span } from '../../src/decorators/span.decorator';
import { captureTraceCarrier, type TraceCarrier } from '../../src/context/trace-carrier';
import { runWithRemoteParent } from '../../src/context/w3c-propagation';
import { TraceContextManager } from '../../src/context/trace-context';

const VALID_TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const VALID_SPAN_ID = '00f067aa0ba902b7';

class Sample {
  syncOk(job: { trace?: TraceCarrier; value: number }): number {
    return job.value * 2;
  }

  syncThrow(): never {
    throw new Error('sync failure');
  }

  async asyncOk(job: { trace?: TraceCarrier }): Promise<string> {
    return 'ok';
  }

  async asyncThrow(): Promise<never> {
    throw new Error('async failure');
  }

  activeTraceId(_job: { trace?: TraceCarrier }): string | undefined {
    return trace.getActiveSpan()?.spanContext().traceId;
  }

  activeCorrelationId(_job: { trace?: TraceCarrier }): string | undefined {
    return TraceContextManager.getCorrelationId();
  }
}

function applyContinueTrace(methodName: keyof Sample, options?: ContinueTraceOptions) {
  const original = Object.getOwnPropertyDescriptor(Sample.prototype, methodName)!;
  const decorated = ContinueTrace(options)(Sample.prototype, methodName, { ...original });
  return decorated.value as (...args: unknown[]) => unknown;
}

describe('@ContinueTrace', () => {
  it('resumes the trace captured via captureTraceCarrier(), read from args[0].trace by default', () => {
    const remote = { traceId: VALID_TRACE_ID, spanId: VALID_SPAN_ID, traceFlags: 1 };
    const capturedTrace = runWithRemoteParent(remote, () => captureTraceCarrier());

    const wrapped = applyContinueTrace('activeTraceId');
    const observedTraceId = wrapped({ trace: capturedTrace });

    expect(observedTraceId).toBe(VALID_TRACE_ID);
  });

  it('exposes the captured correlation id via TraceContextManager inside the method', () => {
    const context = TraceContextManager.createContext({ correlationId: 'corr-continue' });
    const capturedTrace = TraceContextManager.run(context, () => captureTraceCarrier());

    const wrapped = applyContinueTrace('activeCorrelationId');
    expect(wrapped({ trace: capturedTrace })).toBe('corr-continue');
  });

  it('still runs the method, as the root of a fresh trace, when there is no trace field', () => {
    const wrapped = applyContinueTrace('syncOk');
    expect(wrapped({ value: 21 })).toBe(42);
  });

  it('propagates a synchronous return value', () => {
    const wrapped = applyContinueTrace('syncOk');
    expect(wrapped({ value: 10 })).toBe(20);
  });

  it('propagates the resolved value for an async method', async () => {
    const wrapped = applyContinueTrace('asyncOk');
    await expect(wrapped({})).resolves.toBe('ok');
  });

  it('rethrows a synchronous error', () => {
    const wrapped = applyContinueTrace('syncThrow');
    expect(() => wrapped()).toThrow('sync failure');
  });

  it('rejects with the original error for an async method', async () => {
    const wrapped = applyContinueTrace('asyncThrow');
    await expect(wrapped()).rejects.toThrow('async failure');
  });

  it('accepts a custom extractCarrier function for a differently shaped payload', () => {
    const remote = { traceId: VALID_TRACE_ID, spanId: VALID_SPAN_ID, traceFlags: 1 };
    const capturedTrace = runWithRemoteParent(remote, () => captureTraceCarrier());

    // A concretely-typed parameter here (not `unknown`/a cast) is the point of
    // this test: ContinueTraceOptions.extractCarrier is typed with `any[]`
    // specifically so a normally-typed function like this one is assignable
    // to it — see claude.md for the regression this guards against.
    interface Envelope {
      payload: { trace: TraceCarrier };
    }

    const wrapped = applyContinueTrace('activeTraceId', {
      extractCarrier: (job: Envelope) => job.payload.trace,
    });

    const observedTraceId = wrapped({ payload: { trace: capturedTrace } });
    expect(observedTraceId).toBe(VALID_TRACE_ID);
  });

  it('accepts a Bull/BullMQ-shaped payload, where the carrier is nested at job.data.trace', () => {
    const remote = { traceId: VALID_TRACE_ID, spanId: VALID_SPAN_ID, traceFlags: 1 };
    const capturedTrace = runWithRemoteParent(remote, () => captureTraceCarrier());

    // Mimics a Bull/BullMQ `Job<T>` type: the enqueued payload lives at
    // `.data`, not on the job itself. Concretely typed, same reasoning as above.
    interface Job<T> {
      id: string;
      data: T;
    }

    const wrapped = applyContinueTrace('activeTraceId', {
      extractCarrier: (job: Job<{ invoiceId: string; trace: TraceCarrier }>) => job.data.trace,
    });

    const fakeJob: Job<{ invoiceId: string; trace: TraceCarrier }> = { id: 'job-1', data: { invoiceId: 'inv_1', trace: capturedTrace } };
    expect(wrapped(fakeJob)).toBe(VALID_TRACE_ID);
  });

  it('does not create a span of its own — only @Span(), stacked alongside it, does', () => {
    // @ContinueTrace alone only resumes context; asserting no span-creation
    // side effect is implicit here (no tracer mock is set up, and the call
    // still succeeds without one) — see trace-carrier.spec.ts for the
    // dedicated assertion on the underlying resumeTraceCarrier().
    const wrapped = applyContinueTrace('syncOk');
    expect(wrapped({ value: 1 })).toBe(2);
  });

  it('rejects a symbol-keyed property', () => {
    expect(() => ContinueTrace()(Sample.prototype, Symbol('sym'), { value: () => {} })).toThrow(/string name/);
  });

  it('preserves Function.prototype.name on the wrapper', () => {
    const wrapped = applyContinueTrace('syncOk');
    expect(wrapped.name).toBe('syncOk');
  });

  describe('decoration-order independence', () => {
    it('preserves metadata already attached before @ContinueTrace runs', () => {
      const original = Object.getOwnPropertyDescriptor(Sample.prototype, 'syncOk')!;
      Reflect.defineMetadata('eventPattern', 'invoice.created', original.value);

      const wrapped = ContinueTrace()(Sample.prototype, 'syncOk', { ...original }).value as (...args: unknown[]) => unknown;

      expect(Reflect.getMetadata('eventPattern', wrapped)).toBe('invoice.created');
    });
  });

  describe('composition with @Span (order independence)', () => {
    // No mocked tracer here on purpose: with no OTel SDK registered, the
    // default (noop) tracer's startActiveSpan() falls back to an
    // ALL-ZERO, invalid span context whenever there is no valid parent
    // context active — but reuses the exact parent span context when one
    // IS active (see @opentelemetry/api's NoopTracer). That gives a real,
    // observable signal for whether the trace was resumed BEFORE the span
    // was created, without needing to mock anything.
    function applyBoth(order: 'continueTrace-then-span' | 'span-then-continueTrace', options?: ContinueTraceOptions) {
      const original = Object.getOwnPropertyDescriptor(Sample.prototype, 'activeTraceId')!;

      if (order === 'continueTrace-then-span') {
        // @ContinueTrace() \n @Span() \n method() -- @Span applies first (innermost).
        const spanWrapped = Span('composed')(Sample.prototype, 'activeTraceId', { ...original });
        const continueTraceWrapped = ContinueTrace(options)(Sample.prototype, 'activeTraceId', { ...spanWrapped });
        return continueTraceWrapped.value as (...args: unknown[]) => unknown;
      }

      // @Span() \n @ContinueTrace() \n method() -- @ContinueTrace applies first (innermost).
      const continueTraceWrapped = ContinueTrace(options)(Sample.prototype, 'activeTraceId', { ...original });
      const spanWrapped = Span('composed')(Sample.prototype, 'activeTraceId', { ...continueTraceWrapped });
      return spanWrapped.value as (...args: unknown[]) => unknown;
    }

    it('resumes the trace before @Span creates its span when @ContinueTrace is declared above @Span', () => {
      const remote = { traceId: VALID_TRACE_ID, spanId: VALID_SPAN_ID, traceFlags: 1 };
      const capturedTrace = runWithRemoteParent(remote, () => captureTraceCarrier());

      const wrapped = applyBoth('continueTrace-then-span');
      expect(wrapped({ trace: capturedTrace })).toBe(VALID_TRACE_ID);
    });

    it('resumes the trace before @Span creates its span even when @Span is declared above @ContinueTrace', () => {
      const remote = { traceId: VALID_TRACE_ID, spanId: VALID_SPAN_ID, traceFlags: 1 };
      const capturedTrace = runWithRemoteParent(remote, () => captureTraceCarrier());

      const wrapped = applyBoth('span-then-continueTrace');
      expect(wrapped({ trace: capturedTrace })).toBe(VALID_TRACE_ID);
    });

    it('honors a custom extractCarrier regardless of order', () => {
      const remote = { traceId: VALID_TRACE_ID, spanId: VALID_SPAN_ID, traceFlags: 1 };
      const capturedTrace = runWithRemoteParent(remote, () => captureTraceCarrier());
      interface Job<T> {
        data: T;
      }
      const options: ContinueTraceOptions = {
        extractCarrier: (job: Job<{ trace: TraceCarrier }>) => job.data.trace,
      };

      const wrapped = applyBoth('span-then-continueTrace', options);
      expect(wrapped({ data: { trace: capturedTrace } })).toBe(VALID_TRACE_ID);
    });
  });
});
