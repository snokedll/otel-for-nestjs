import type { NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { isSpanContextValid, type SpanContext } from '@opentelemetry/api';
import { TraceContextManager, type TraceContext } from '../context/trace-context';
import { runWithRemoteParent } from '../context/w3c-propagation';

export type SignalOutcome = 'success' | 'error';

/**
 * Template Method base for the SDK's trace interceptors. Implements the
 * control flow shared by every transport (extract, ignore-check, context
 * propagation, metric recording) once; concrete subclasses only describe
 * transport-specific extraction and recording.
 *
 * The one correctness constraint this class exists to get right once,
 * rather than in each subclass: when a remote parent span is present, it
 * must stay active for the SAME synchronous call that invokes
 * `next.handle().subscribe()` — an `Observable`'s subscriber function only
 * runs once something subscribes to it, which happens after `intercept()`
 * has already returned. Constructing the `Observable` inside the remote
 * parent's scope would therefore silently fail to parent any span opened
 * downstream.
 *
 * @typeParam TSignalContext transport-specific data extracted once per invocation and threaded through the template's hooks.
 */
export abstract class BaseTraceInterceptor<TSignalContext> implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (!this.supports(context)) return next.handle();

    const signalContext = this.extractSignalContext(context);
    if (this.shouldIgnore(signalContext)) return next.handle();

    const correlationId = this.extractCorrelationId(signalContext);
    const remoteParent = this.extractRemoteParent(signalContext);

    return new Observable((subscriber) => {
      const runInContext = (): void => {
        const traceContext = TraceContextManager.createContext({ correlationId });
        this.beforeRun(signalContext, traceContext);

        TraceContextManager.run(traceContext, () => {
          const startTime = Date.now();

          next.handle().subscribe({
            next: (value) => {
              this.recordOutcome(signalContext, 'success', Date.now() - startTime);
              subscriber.next(value);
            },
            error: (error: unknown) => {
              this.recordOutcome(signalContext, 'error', Date.now() - startTime);
              subscriber.error(error);
            },
            complete: () => subscriber.complete(),
          });
        });
      };

      if (remoteParent && isSpanContextValid(remoteParent)) {
        runWithRemoteParent(remoteParent, runInContext);
      } else {
        runInContext();
      }
    });
  }

  /** @returns whether this interceptor applies to `context`'s execution type (e.g. `'http'`, `'rpc'`). */
  protected abstract supports(context: ExecutionContext): boolean;

  /** Extracts the transport-specific data every other hook needs, once per invocation. */
  protected abstract extractSignalContext(context: ExecutionContext): TSignalContext;

  /** @returns whether this invocation should bypass instrumentation entirely. */
  protected abstract shouldIgnore(signalContext: TSignalContext): boolean;

  /** @returns the business correlation identifier for this invocation, if any. */
  protected abstract extractCorrelationId(signalContext: TSignalContext): string | undefined;

  /** @returns a remote span to parent this invocation's trace to, if any. Defaults to none. */
  protected extractRemoteParent(_signalContext: TSignalContext): SpanContext | undefined {
    return undefined;
  }

  /** Runs once the trace context is resolved but before downstream handlers run — e.g. to set response headers. */
  protected beforeRun(_signalContext: TSignalContext, _traceContext: TraceContext): void {}

  /** Records metrics for this invocation's outcome. */
  protected abstract recordOutcome(signalContext: TSignalContext, outcome: SignalOutcome, durationMs: number): void;
}
