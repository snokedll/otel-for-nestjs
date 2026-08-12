import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { of, throwError, firstValueFrom } from 'rxjs';
import type { ExecutionContext, CallHandler } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import { HttpTraceInterceptor } from '../../src/interceptors/http-trace.interceptor';
import { resolveTelemetryConfig } from '../../src/config/telemetry-config';
import { CorrelationSource } from '../../src/context/correlation-id-extractor';
import { createFakeMeter } from '../support/otel-mocks';

// MetricsService caches instruments by name at module scope, so the meter
// mock must be installed before the FIRST HttpTraceInterceptor is
// constructed in this file — every instance afterwards resolves the same
// cached counter/histogram regardless of which mock is active by then.
const meter = createFakeMeter();
vi.spyOn(metrics, 'getMeter').mockReturnValue(meter as never);

const requestsCounter = () => meter.created['counter:http.server.requests'] as { add: ReturnType<typeof vi.fn> };
const requestDuration = () => meter.created['histogram:http.server.request.duration'] as { record: ReturnType<typeof vi.fn> };

function createHttpContext(overrides: {
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
  url?: string;
  method?: string;
  statusCode?: number;
  className?: string;
  methodName?: string;
  type?: string;
}) {
  const request = {
    headers: overrides.headers ?? {},
    body: overrides.body,
    method: overrides.method ?? 'GET',
    originalUrl: overrides.url ?? '/invoices/1',
  };
  const setHeader = vi.fn();
  const response = { statusCode: overrides.statusCode ?? 200, setHeader };
  const context = {
    getType: () => overrides.type ?? 'http',
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
    getClass: () => ({ name: overrides.className ?? 'InvoicesController' }),
    getHandler: () => ({ name: overrides.methodName ?? 'findOne' }),
  } as unknown as ExecutionContext;
  return { context, request, response, setHeader };
}

function callHandlerFor(fn: () => unknown): CallHandler {
  return { handle: () => of(fn()) };
}

function errorCallHandler(error: unknown): CallHandler {
  return { handle: () => throwError(() => error) };
}

let interceptor: HttpTraceInterceptor;

beforeAll(() => {
  interceptor = new HttpTraceInterceptor(resolveTelemetryConfig({ serviceName: 'svc' }));
});

beforeEach(() => {
  requestsCounter().add.mockClear();
  requestDuration().record.mockClear();
});

describe('HttpTraceInterceptor', () => {
  it('passes through untouched for a non-http execution context', async () => {
    const { context, setHeader } = createHttpContext({ type: 'rpc' });

    const result = await firstValueFrom(interceptor.intercept(context, callHandlerFor(() => 'value')));

    expect(result).toBe('value');
    expect(setHeader).not.toHaveBeenCalled();
  });

  it('bypasses instrumentation entirely for an ignored route', async () => {
    const ignoringInterceptor = new HttpTraceInterceptor(resolveTelemetryConfig({ serviceName: 'svc', ignoreRoutes: ['/health'] }));
    const { context, setHeader } = createHttpContext({ url: '/health' });

    await firstValueFrom(ignoringInterceptor.intercept(context, callHandlerFor(() => 'ok')));

    expect(setHeader).not.toHaveBeenCalled();
    expect(requestsCounter().add).not.toHaveBeenCalled();
  });

  it('sets the x-trace-id response header on every non-ignored request', async () => {
    const { context, setHeader } = createHttpContext({});
    await firstValueFrom(interceptor.intercept(context, callHandlerFor(() => 'ok')));
    expect(setHeader).toHaveBeenCalledWith('x-trace-id', expect.stringMatching(/^[0-9a-f]{32}$/));
  });

  it('extracts the correlation id from the default header and reflects it back', async () => {
    const { context, setHeader } = createHttpContext({ headers: { 'x-correlation-id': 'corr-1' } });
    await firstValueFrom(interceptor.intercept(context, callHandlerFor(() => 'ok')));
    expect(setHeader).toHaveBeenCalledWith('x-correlation-id', 'corr-1');
  });

  it('does not set an x-correlation-id header when none was resolved', async () => {
    const { context, setHeader } = createHttpContext({});
    await firstValueFrom(interceptor.intercept(context, callHandlerFor(() => 'ok')));
    expect(setHeader).not.toHaveBeenCalledWith('x-correlation-id', expect.anything());
  });

  it('extracts the correlation id from the request body when configured', async () => {
    const bodyInterceptor = new HttpTraceInterceptor(
      resolveTelemetryConfig({ serviceName: 'svc', correlationIdSources: [{ from: 'body', key: 'correlationId' }] }),
    );
    const { context, setHeader } = createHttpContext({ body: { correlationId: 'from-body' } });

    await firstValueFrom(bodyInterceptor.intercept(context, callHandlerFor(() => 'ok')));

    expect(setHeader).toHaveBeenCalledWith('x-correlation-id', 'from-body');
  });

  it('applies a source scoped to CorrelationSource.HTTP', async () => {
    const scopedInterceptor = new HttpTraceInterceptor(
      resolveTelemetryConfig({
        serviceName: 'svc',
        correlationIdSources: [{ from: 'header', key: 'x-correlation-id', source: CorrelationSource.HTTP }],
      }),
    );
    const { context, setHeader } = createHttpContext({ headers: { 'x-correlation-id': 'scoped-http' } });

    await firstValueFrom(scopedInterceptor.intercept(context, callHandlerFor(() => 'ok')));

    expect(setHeader).toHaveBeenCalledWith('x-correlation-id', 'scoped-http');
  });

  it('ignores a source scoped to CorrelationSource.MESSAGE', async () => {
    const scopedInterceptor = new HttpTraceInterceptor(
      resolveTelemetryConfig({
        serviceName: 'svc',
        correlationIdSources: [{ from: 'header', key: 'x-correlation-id', source: CorrelationSource.MESSAGE }],
      }),
    );
    const { context, setHeader } = createHttpContext({ headers: { 'x-correlation-id': 'scoped-message' } });

    await firstValueFrom(scopedInterceptor.intercept(context, callHandlerFor(() => 'ok')));

    expect(setHeader).not.toHaveBeenCalledWith('x-correlation-id', expect.anything());
  });

  it('records request metrics tagged with method, ClassName.methodName, and the response status', async () => {
    const { context } = createHttpContext({ method: 'POST', statusCode: 201, className: 'InvoicesController', methodName: 'create' });

    await firstValueFrom(interceptor.intercept(context, callHandlerFor(() => 'ok')));

    expect(requestsCounter().add).toHaveBeenCalledWith(1, { method: 'POST', route: 'InvoicesController.create', status_code: 201 });
  });

  it('records status_code as the literal "error" when the downstream handler errors', async () => {
    const { context } = createHttpContext({});

    await expect(firstValueFrom(interceptor.intercept(context, errorCallHandler(new Error('boom'))))).rejects.toThrow('boom');

    expect(requestsCounter().add).toHaveBeenCalledWith(1, expect.objectContaining({ status_code: 'error' }));
  });

  it('records a duration alongside the request count', async () => {
    const { context } = createHttpContext({});
    await firstValueFrom(interceptor.intercept(context, callHandlerFor(() => 'ok')));
    expect(requestDuration().record).toHaveBeenCalledWith(expect.any(Number), expect.any(Object));
  });

  it('never uses the raw URL as a metric attribute', async () => {
    const { context } = createHttpContext({ url: '/invoices/inv_7f2a9c' });

    await firstValueFrom(interceptor.intercept(context, callHandlerFor(() => 'ok')));

    const attributes = requestsCounter().add.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.values(attributes)).not.toContain('/invoices/inv_7f2a9c');
  });
});
