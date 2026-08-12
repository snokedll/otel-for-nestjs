import { describe, it, expect, vi } from 'vitest';
import { Observable, of, throwError, firstValueFrom } from 'rxjs';
import type { ExecutionContext, CallHandler } from '@nestjs/common';
import { trace, type SpanContext } from '@opentelemetry/api';
import { BaseTraceInterceptor, type SignalOutcome } from '../../src/interceptors/base-trace.interceptor';
import { TraceContextManager } from '../../src/context/trace-context';

interface TestSignalContext {
  correlationId?: string;
  remoteParent?: SpanContext;
  ignore?: boolean;
  supports?: boolean;
}

class TestInterceptor extends BaseTraceInterceptor<TestSignalContext> {
  public readonly recordedOutcomes: Array<{ outcome: SignalOutcome; durationMs: number }> = [];
  public readonly beforeRunCalls: unknown[] = [];
  public observedCorrelationIdDuringRun?: string;
  public observedActiveTraceIdDuringRun?: string;

  constructor(private readonly signalContext: TestSignalContext) {
    super();
  }

  protected supports(): boolean {
    return this.signalContext.supports ?? true;
  }

  protected extractSignalContext(): TestSignalContext {
    return this.signalContext;
  }

  protected shouldIgnore(signalContext: TestSignalContext): boolean {
    return signalContext.ignore ?? false;
  }

  protected extractCorrelationId(signalContext: TestSignalContext): string | undefined {
    return signalContext.correlationId;
  }

  protected extractRemoteParent(signalContext: TestSignalContext): SpanContext | undefined {
    return signalContext.remoteParent;
  }

  protected beforeRun(signalContext: TestSignalContext): void {
    this.beforeRunCalls.push(signalContext);
    this.observedCorrelationIdDuringRun = TraceContextManager.getCorrelationId();
    this.observedActiveTraceIdDuringRun = trace.getActiveSpan()?.spanContext().traceId;
  }

  protected recordOutcome(_signalContext: TestSignalContext, outcome: SignalOutcome, durationMs: number): void {
    this.recordedOutcomes.push({ outcome, durationMs });
  }
}

function callHandlerFor(observable: Observable<unknown>): CallHandler {
  return { handle: () => observable };
}

const dummyContext = {} as ExecutionContext;

describe('BaseTraceInterceptor', () => {
  it('bypasses entirely when supports() is false', async () => {
    const interceptor = new TestInterceptor({ supports: false });
    const handler = callHandlerFor(of('passthrough'));

    const result = await firstValueFrom(interceptor.intercept(dummyContext, handler));

    expect(result).toBe('passthrough');
    expect(interceptor.recordedOutcomes).toEqual([]);
    expect(interceptor.beforeRunCalls).toEqual([]);
  });

  it('bypasses entirely when shouldIgnore() is true', async () => {
    const interceptor = new TestInterceptor({ ignore: true });
    const handler = callHandlerFor(of('passthrough'));

    const result = await firstValueFrom(interceptor.intercept(dummyContext, handler));

    expect(result).toBe('passthrough');
    expect(interceptor.recordedOutcomes).toEqual([]);
    expect(interceptor.beforeRunCalls).toEqual([]);
  });

  it('runs beforeRun before the downstream handler emits', async () => {
    const interceptor = new TestInterceptor({});
    await firstValueFrom(interceptor.intercept(dummyContext, callHandlerFor(of('value'))));
    expect(interceptor.beforeRunCalls).toHaveLength(1);
  });

  it('exposes the resolved correlation id to code running inside the downstream handler', async () => {
    let observed: string | undefined;
    const handler: CallHandler = {
      handle: () =>
        new Observable((subscriber) => {
          observed = TraceContextManager.getCorrelationId();
          subscriber.next('value');
          subscriber.complete();
        }),
    };

    const interceptor = new TestInterceptor({ correlationId: 'corr-xyz' });
    await firstValueFrom(interceptor.intercept(dummyContext, handler));

    expect(observed).toBe('corr-xyz');
  });

  it('resolves beforeRun before entering the trace context, exposing the correlation id via the traceContext argument instead', async () => {
    let observedFromArgument: string | undefined;
    class ArgumentCheckingInterceptor extends TestInterceptor {
      protected override beforeRun(signalContext: TestSignalContext, traceContext: { correlationId?: string }): void {
        super.beforeRun(signalContext, traceContext as never);
        observedFromArgument = traceContext.correlationId;
      }
    }

    const interceptor = new ArgumentCheckingInterceptor({ correlationId: 'corr-arg' });
    await firstValueFrom(interceptor.intercept(dummyContext, callHandlerFor(of('value'))));

    expect(observedFromArgument).toBe('corr-arg');
    expect(interceptor.observedCorrelationIdDuringRun).toBeUndefined();
  });

  it('records a success outcome and forwards the emitted value', async () => {
    const interceptor = new TestInterceptor({});
    const result = await firstValueFrom(interceptor.intercept(dummyContext, callHandlerFor(of('the-value'))));

    expect(result).toBe('the-value');
    expect(interceptor.recordedOutcomes).toHaveLength(1);
    expect(interceptor.recordedOutcomes[0].outcome).toBe('success');
    expect(interceptor.recordedOutcomes[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('records an error outcome and forwards the error', async () => {
    const interceptor = new TestInterceptor({});
    const failure = new Error('downstream failure');

    await expect(firstValueFrom(interceptor.intercept(dummyContext, callHandlerFor(throwError(() => failure))))).rejects.toBe(failure);
    expect(interceptor.recordedOutcomes[0].outcome).toBe('error');
  });

  it('completes the observable when the downstream handler completes', async () => {
    const interceptor = new TestInterceptor({});
    let completed = false;

    await new Promise<void>((resolve) => {
      interceptor.intercept(dummyContext, callHandlerFor(of('value'))).subscribe({
        complete: () => {
          completed = true;
          resolve();
        },
      });
    });

    expect(completed).toBe(true);
  });

  describe('remote parent propagation', () => {
    const remoteSpanContext: SpanContext = {
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
      traceFlags: 1,
    };

    it('makes the remote span active for beforeRun and, critically, for the downstream handler subscription itself', async () => {
      let observedDuringHandle: string | undefined;
      const handler: CallHandler = {
        handle: () =>
          new Observable((subscriber) => {
            observedDuringHandle = trace.getActiveSpan()?.spanContext().traceId;
            subscriber.next('value');
            subscriber.complete();
          }),
      };

      const interceptor = new TestInterceptor({ remoteParent: remoteSpanContext });
      await firstValueFrom(interceptor.intercept(dummyContext, handler));

      expect(interceptor.observedActiveTraceIdDuringRun).toBe(remoteSpanContext.traceId);
      expect(observedDuringHandle).toBe(remoteSpanContext.traceId);
    });

    it('ignores an invalid remote span context (all-zero sentinel)', async () => {
      const interceptor = new TestInterceptor({
        remoteParent: { traceId: '0'.repeat(32), spanId: '0'.repeat(16), traceFlags: 0 },
      });
      await firstValueFrom(interceptor.intercept(dummyContext, callHandlerFor(of('value'))));
      expect(interceptor.observedActiveTraceIdDuringRun).toBeUndefined();
    });
  });

  it('does not leak trace context outside of intercept()', async () => {
    const interceptor = new TestInterceptor({ correlationId: 'leak-check' });
    await firstValueFrom(interceptor.intercept(dummyContext, callHandlerFor(of('value'))));
    expect(TraceContextManager.getCorrelationId()).toBeUndefined();
  });
});
