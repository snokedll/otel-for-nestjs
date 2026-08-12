import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { Observable, of, throwError, firstValueFrom } from 'rxjs';
import type { ExecutionContext, CallHandler } from '@nestjs/common';
import { metrics, trace } from '@opentelemetry/api';
import { MessageTraceInterceptor } from '../../src/interceptors/message-trace.interceptor';
import { resolveTelemetryConfig } from '../../src/config/telemetry-config';
import { CorrelationSource } from '../../src/context/correlation-id-extractor';
import { TraceContextManager } from '../../src/context/trace-context';
import { createFakeMeter } from '../support/otel-mocks';

const meter = createFakeMeter();
vi.spyOn(metrics, 'getMeter').mockReturnValue(meter as never);

const messagesCounter = () => meter.created['counter:messaging.kafka.messages_consumed'] as { add: ReturnType<typeof vi.fn> };
const processingDuration = () =>
  meter.created['histogram:messaging.kafka.processing.duration'] as { record: ReturnType<typeof vi.fn> };

const VALID_TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const VALID_SPAN_ID = '00f067aa0ba902b7';

function createRpcContext(overrides: {
  headers?: Record<string, string | Buffer | undefined>;
  body?: unknown;
  topic?: string;
  partition?: number;
  offset?: string;
  type?: string;
}) {
  const kafkaMessage = { headers: overrides.headers ?? {}, offset: overrides.offset ?? '0' };
  const kafkaContext = {
    getMessage: () => kafkaMessage,
    getTopic: () => overrides.topic ?? 'invoice.created',
    getPartition: () => overrides.partition ?? 0,
  };
  const context = {
    getType: () => overrides.type ?? 'rpc',
    switchToRpc: () => ({ getContext: () => kafkaContext, getData: () => overrides.body }),
  } as unknown as ExecutionContext;
  return { context };
}

function callHandlerFor(fn: () => unknown): CallHandler {
  return { handle: () => of(fn()) };
}

function activeSpanCallHandler(capture: { traceId?: string }): CallHandler {
  return {
    handle: () =>
      new Observable((subscriber) => {
        capture.traceId = trace.getActiveSpan()?.spanContext().traceId;
        subscriber.next('value');
        subscriber.complete();
      }),
  };
}

function errorCallHandler(error: unknown): CallHandler {
  return { handle: () => throwError(() => error) };
}

let interceptor: MessageTraceInterceptor;

beforeAll(() => {
  interceptor = new MessageTraceInterceptor(resolveTelemetryConfig({ serviceName: 'svc' }));
});

beforeEach(() => {
  messagesCounter().add.mockClear();
  processingDuration().record.mockClear();
});

describe('MessageTraceInterceptor', () => {
  it('passes through untouched for a non-rpc execution context', async () => {
    const { context } = createRpcContext({ type: 'http' });
    const result = await firstValueFrom(interceptor.intercept(context, callHandlerFor(() => 'value')));
    expect(result).toBe('value');
    expect(messagesCounter().add).not.toHaveBeenCalled();
  });

  it('bypasses instrumentation entirely for an ignored event', async () => {
    const ignoringInterceptor = new MessageTraceInterceptor(
      resolveTelemetryConfig({ serviceName: 'svc', ignoreEvents: [{ body: { name: 'HEALTH_CHECK' } }] }),
    );
    const { context } = createRpcContext({ body: { name: 'HEALTH_CHECK' } });

    await firstValueFrom(ignoringInterceptor.intercept(context, callHandlerFor(() => 'ok')));

    expect(messagesCounter().add).not.toHaveBeenCalled();
  });

  it('still processes a non-matching event normally', async () => {
    const ignoringInterceptor = new MessageTraceInterceptor(
      resolveTelemetryConfig({ serviceName: 'svc', ignoreEvents: [{ body: { name: 'HEALTH_CHECK' } }] }),
    );
    const { context } = createRpcContext({ body: { id: 'inv_1' } });

    await firstValueFrom(ignoringInterceptor.intercept(context, callHandlerFor(() => 'ok')));

    expect(messagesCounter().add).toHaveBeenCalled();
  });

  function correlationCapturingHandler(capture: { correlationId?: string }): CallHandler {
    return {
      handle: () =>
        new Observable((subscriber) => {
          capture.correlationId = TraceContextManager.getCorrelationId();
          subscriber.next('value');
          subscriber.complete();
        }),
    };
  }

  it('extracts the correlation id from message headers', async () => {
    const capture: { correlationId?: string } = {};
    const { context } = createRpcContext({ headers: { 'x-correlation-id': 'corr-kafka' } });

    await firstValueFrom(interceptor.intercept(context, correlationCapturingHandler(capture)));

    expect(capture.correlationId).toBe('corr-kafka');
  });

  it('extracts the correlation id from the event body when configured', async () => {
    const bodyInterceptor = new MessageTraceInterceptor(
      resolveTelemetryConfig({ serviceName: 'svc', correlationIdSources: [{ from: 'body', key: 'correlationId' }] }),
    );
    const capture: { correlationId?: string } = {};
    const { context } = createRpcContext({ body: { correlationId: 'body-corr' } });

    await firstValueFrom(bodyInterceptor.intercept(context, correlationCapturingHandler(capture)));

    expect(capture.correlationId).toBe('body-corr');
  });

  it('applies a source scoped to CorrelationSource.MESSAGE', async () => {
    const scopedInterceptor = new MessageTraceInterceptor(
      resolveTelemetryConfig({
        serviceName: 'svc',
        correlationIdSources: [{ from: 'header', key: 'x-correlation-id', source: CorrelationSource.MESSAGE }],
      }),
    );
    const capture: { correlationId?: string } = {};
    const { context } = createRpcContext({ headers: { 'x-correlation-id': 'scoped-message' } });

    await firstValueFrom(scopedInterceptor.intercept(context, correlationCapturingHandler(capture)));

    expect(capture.correlationId).toBe('scoped-message');
  });

  it('ignores a source scoped to CorrelationSource.HTTP', async () => {
    const scopedInterceptor = new MessageTraceInterceptor(
      resolveTelemetryConfig({
        serviceName: 'svc',
        correlationIdSources: [{ from: 'header', key: 'x-correlation-id', source: CorrelationSource.HTTP }],
      }),
    );
    const capture: { correlationId?: string } = {};
    const { context } = createRpcContext({ headers: { 'x-correlation-id': 'scoped-http' } });

    await firstValueFrom(scopedInterceptor.intercept(context, correlationCapturingHandler(capture)));

    expect(capture.correlationId).toBeUndefined();
  });

  it('re-parents the trace to a valid traceparent header for the downstream handler', async () => {
    const capture: { traceId?: string } = {};
    const { context } = createRpcContext({ headers: { traceparent: `00-${VALID_TRACE_ID}-${VALID_SPAN_ID}-01` } });

    await firstValueFrom(interceptor.intercept(context, activeSpanCallHandler(capture)));

    expect(capture.traceId).toBe(VALID_TRACE_ID);
  });

  it('ignores an absent or malformed traceparent header', async () => {
    const capture: { traceId?: string } = {};
    const { context } = createRpcContext({ headers: {} });

    await firstValueFrom(interceptor.intercept(context, activeSpanCallHandler(capture)));

    expect(capture.traceId).toBeUndefined();
  });

  it('records messaging metrics tagged with topic, partition, and outcome', async () => {
    const { context } = createRpcContext({ topic: 'invoice.created', partition: 2 });

    await firstValueFrom(interceptor.intercept(context, callHandlerFor(() => 'ok')));

    expect(messagesCounter().add).toHaveBeenCalledWith(1, { topic: 'invoice.created', partition: 2, outcome: 'success' });
    expect(processingDuration().record).toHaveBeenCalledWith(expect.any(Number), expect.objectContaining({ outcome: 'success' }));
  });

  it('records an error outcome and rethrows when the handler errors', async () => {
    const { context } = createRpcContext({});
    const failure = new Error('processing failed');

    await expect(firstValueFrom(interceptor.intercept(context, errorCallHandler(failure)))).rejects.toBe(failure);

    expect(messagesCounter().add).toHaveBeenCalledWith(1, expect.objectContaining({ outcome: 'error' }));
  });

  it('never uses the message offset as a metric attribute', async () => {
    const { context } = createRpcContext({ offset: '918273' });

    await firstValueFrom(interceptor.intercept(context, callHandlerFor(() => 'ok')));

    const attributes = messagesCounter().add.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.values(attributes)).not.toContain('918273');
  });
});
