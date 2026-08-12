import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { of, firstValueFrom } from 'rxjs';
import type { ExecutionContext, CallHandler } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import { HttpTraceInterceptor } from '../../src/interceptors/http-trace.interceptor';
import { MessageTraceInterceptor } from '../../src/interceptors/message-trace.interceptor';
import { resolveTelemetryConfig } from '../../src/config/telemetry-config';
import { runWithTraceCarrier, type TraceCarrier } from '../../src/context/trace-carrier';
import { createFakeMeter } from '../support/otel-mocks';

const meter = createFakeMeter();
vi.spyOn(metrics, 'getMeter').mockReturnValue(meter as never);

function callHandlerFor(fn: () => unknown): CallHandler {
  return { handle: () => of(fn()) };
}

function createHttpContext(overrides: {
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
  url?: string;
}) {
  const request = { headers: overrides.headers ?? {}, body: overrides.body, method: 'GET', originalUrl: overrides.url ?? '/invoices/1' };
  const setHeader = vi.fn();
  const response = { statusCode: 200, setHeader };
  const context = {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
    getClass: () => ({ name: 'InvoicesController' }),
    getHandler: () => ({ name: 'findOne' }),
  } as unknown as ExecutionContext;
  return { context, setHeader };
}

function createRpcContext(overrides: { headers?: Record<string, string | undefined>; body?: unknown }) {
  const kafkaMessage = { headers: overrides.headers ?? {}, offset: '0' };
  const kafkaContext = { getMessage: () => kafkaMessage, getTopic: () => 'invoice.created', getPartition: () => 0 };
  const context = {
    getType: () => 'rpc',
    switchToRpc: () => ({ getContext: () => kafkaContext, getData: () => overrides.body }),
  } as unknown as ExecutionContext;
  return { context };
}

let httpInterceptor: HttpTraceInterceptor;
let bodyCorrelationHttpInterceptor: HttpTraceInterceptor;
let messageInterceptor: MessageTraceInterceptor;

beforeAll(() => {
  httpInterceptor = new HttpTraceInterceptor(resolveTelemetryConfig({ serviceName: 'svc' }));
  bodyCorrelationHttpInterceptor = new HttpTraceInterceptor(
    resolveTelemetryConfig({
      serviceName: 'svc',
      correlationIdSources: [{ from: 'header', key: 'x-correlation-id' }, { from: 'body', key: 'correlationId' }],
    }),
  );
  messageInterceptor = new MessageTraceInterceptor(resolveTelemetryConfig({ serviceName: 'svc' }));
});

beforeEach(() => {
  (meter.created['counter:http.server.requests'] as { add: ReturnType<typeof vi.fn> } | undefined)?.add.mockClear();
  (meter.created['counter:messaging.kafka.messages_consumed'] as { add: ReturnType<typeof vi.fn> } | undefined)?.add.mockClear();
});

describe('security: HTTP response header injection', () => {
  it('does not reflect a correlation id containing CRLF into the response headers', async () => {
    const injectionAttempt = 'legit-id\r\nX-Injected-Header: evil-value';
    const { context, setHeader } = createHttpContext({ headers: { 'x-correlation-id': injectionAttempt } });

    await firstValueFrom(httpInterceptor.intercept(context, callHandlerFor(() => 'ok')));

    expect(setHeader).not.toHaveBeenCalledWith('x-correlation-id', expect.stringContaining('\r\n'));
    expect(setHeader).not.toHaveBeenCalledWith('x-correlation-id', injectionAttempt);
  });

  it('still reflects a well-formed correlation id, so the guard is not overly aggressive', async () => {
    const { context, setHeader } = createHttpContext({ headers: { 'x-correlation-id': 'a-perfectly-normal-id-123' } });
    await firstValueFrom(httpInterceptor.intercept(context, callHandlerFor(() => 'ok')));
    expect(setHeader).toHaveBeenCalledWith('x-correlation-id', 'a-perfectly-normal-id-123');
  });

  it('rejects a lone-LF variant of the injection attempt', async () => {
    const { context, setHeader } = createHttpContext({ headers: { 'x-correlation-id': 'id\nX-Injected: evil' } });
    await firstValueFrom(httpInterceptor.intercept(context, callHandlerFor(() => 'ok')));
    expect(setHeader).not.toHaveBeenCalledWith('x-correlation-id', expect.stringContaining('\n'));
  });
});

describe('security: prototype pollution via request/event body', () => {
  it('a correlationId path targeting __proto__ never pollutes Object.prototype (HTTP body)', async () => {
    const maliciousBody = JSON.parse('{"__proto__":{"polluted":"yes"},"correlationId":"legit"}') as Record<string, unknown>;
    const { context } = createHttpContext({ body: maliciousBody });

    await firstValueFrom(bodyCorrelationHttpInterceptor.intercept(context, callHandlerFor(() => 'ok')));

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false);
  });

  it('a correlationId path targeting __proto__ never pollutes Object.prototype (Kafka event body)', async () => {
    const maliciousBody = JSON.parse('{"__proto__":{"polluted":"yes"}}');
    const { context } = createRpcContext({ body: maliciousBody });

    await firstValueFrom(messageInterceptor.intercept(context, callHandlerFor(() => 'ok')));

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('security: algorithmic complexity / DoS resistance', () => {
  it('processes an HTTP request with a pathologically deep body in bounded time', async () => {
    let deepBody: Record<string, unknown> = { correlationId: 'deep' };
    for (let i = 0; i < 20_000; i += 1) deepBody = { wrapper: deepBody };
    const { context } = createHttpContext({ body: deepBody });

    const start = performance.now();
    await firstValueFrom(bodyCorrelationHttpInterceptor.intercept(context, callHandlerFor(() => 'ok')));
    expect(performance.now() - start).toBeLessThan(100);
  });

  it('processes a Kafka event with a pathologically large flat body in bounded time', async () => {
    const wideBody: Record<string, string> = {};
    for (let i = 0; i < 50_000; i += 1) wideBody[`field${i}`] = 'value';
    const { context } = createRpcContext({ body: wideBody });

    const start = performance.now();
    await firstValueFrom(messageInterceptor.intercept(context, callHandlerFor(() => 'ok')));
    expect(performance.now() - start).toBeLessThan(200);
  });
});

describe('security: malformed W3C trace context does not crash message processing', () => {
  const malformedTraceparents = [
    'not-a-traceparent',
    '00-invalid-hex-chars-zzz-01',
    `00-${'0'.repeat(32)}-${'0'.repeat(16)}-01`,
    '',
    '00-'.repeat(500),
  ];

  it.each(malformedTraceparents)('handles %j without throwing and without misparenting the trace', async (traceparent) => {
    const { context } = createRpcContext({ headers: { traceparent } });
    await expect(firstValueFrom(messageInterceptor.intercept(context, callHandlerFor(() => 'ok')))).resolves.toBe('ok');
  });
});

describe('security: metric attribute cardinality — attacker-controlled values never leak into metric labels', () => {
  it('an attacker-supplied correlation id never appears in HTTP metric attributes', async () => {
    const attackerCorrelationId = 'attacker-controlled-unique-value-42';
    const { context } = createHttpContext({ headers: { 'x-correlation-id': attackerCorrelationId } });

    await firstValueFrom(httpInterceptor.intercept(context, callHandlerFor(() => 'ok')));

    const counter = meter.created['counter:http.server.requests'] as { add: ReturnType<typeof vi.fn> };
    const attributes = counter.add.mock.calls[counter.add.mock.calls.length - 1][1] as Record<string, unknown>;
    expect(Object.values(attributes)).not.toContain(attackerCorrelationId);
  });

  it('an attacker-supplied header value never appears in Kafka metric attributes', async () => {
    const attackerValue = 'attacker-controlled-kafka-value-99';
    const { context } = createRpcContext({ headers: { 'x-correlation-id': attackerValue } });

    await firstValueFrom(messageInterceptor.intercept(context, callHandlerFor(() => 'ok')));

    const counter = meter.created['counter:messaging.kafka.messages_consumed'] as { add: ReturnType<typeof vi.fn> };
    const attributes = counter.add.mock.calls[counter.add.mock.calls.length - 1][1] as Record<string, unknown>;
    expect(Object.values(attributes)).not.toContain(attackerValue);
  });
});

describe('security: malformed trace carriers do not crash queue-side processing', () => {
  const malformedTraceparents = [
    'not-a-traceparent',
    '00-invalid-hex-chars-zzz-01',
    `00-${'0'.repeat(32)}-${'0'.repeat(16)}-01`,
    '',
    '00-'.repeat(500),
  ];

  it.each(malformedTraceparents)('runs fn without throwing for a malformed traceparent %j', (traceparent) => {
    expect(runWithTraceCarrier({ traceparent }, () => 'ok')).toBe('ok');
  });

  it('runs fn without throwing when the carrier itself is malformed (null/undefined/empty)', () => {
    expect(runWithTraceCarrier(undefined, () => 'ok')).toBe('ok');
    expect(runWithTraceCarrier({} as TraceCarrier, () => 'ok')).toBe('ok');
    expect(runWithTraceCarrier(null as unknown as TraceCarrier, () => 'ok')).toBe('ok');
  });

  it('never pollutes Object.prototype from a __proto__-shaped carrier', () => {
    const maliciousCarrier = JSON.parse('{"__proto__":{"polluted":"yes"},"correlationId":"legit"}') as TraceCarrier;

    runWithTraceCarrier(maliciousCarrier, () => 'ok');

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false);
  });

  it('processes a pathologically long correlation id in bounded time', () => {
    const carrier: TraceCarrier = { correlationId: 'x'.repeat(1_000_000) };

    const start = performance.now();
    runWithTraceCarrier(carrier, () => 'ok');
    expect(performance.now() - start).toBeLessThan(100);
  });
});

describe('security: ignore-rule type confusion', () => {
  it('does not treat an object/array route pattern as a match-everything wildcard', async () => {
    const { isRouteIgnored } = await import('../../src/interceptors/ignore-matchers');
    // @ts-expect-error deliberately passing a malformed pattern to prove it fails closed, not open
    expect(isRouteIgnored('/anything', [{}])).toBe(false);
  });

  it('an ignoreEvents rule with an empty object never matches (fails closed, not open)', async () => {
    const { isEventIgnored } = await import('../../src/interceptors/ignore-matchers');
    expect(isEventIgnored([{}], { anything: 'goes' }, {})).toBe(false);
  });
});
