import { Inject, Injectable, type ExecutionContext } from '@nestjs/common';
import { extractCorrelationId, CorrelationSource } from '../context/correlation-id-extractor';
import type { TraceContext } from '../context/trace-context';
import type { ResolvedTelemetryConfig } from '../config/telemetry-config';
import { MetricsService } from '../metrics/metrics.service';
import { TELEMETRY_CONFIG } from '../nestjs/telemetry.tokens';
import { BaseTraceInterceptor, type SignalOutcome } from './base-trace.interceptor';
import { isRouteIgnored } from './ignore-matchers';

/** Minimal request shape this interceptor depends on — avoids a hard dependency on `@types/express` or fastify. */
interface MinimalRequest {
  headers: Record<string, string | string[] | undefined>;
  method: string;
  url?: string;
  originalUrl?: string;
  body?: unknown;
}

/** Minimal response shape this interceptor depends on — avoids a hard dependency on `@types/express` or fastify. */
interface MinimalResponse {
  statusCode: number;
  setHeader(name: string, value: string): void;
  header?(name: string, value: string): void;
}

interface HttpSignalContext {
  request: MinimalRequest;
  response: MinimalResponse;
  route: string;
}

/** Matches CR/LF, which would let a reflected header value split the HTTP response into extra headers. */
const UNSAFE_HEADER_VALUE_PATTERN = /[\r\n]/;

/**
 * Global HTTP interceptor: resolves the request's correlation identifier
 * and trace context (per {@link ResolvedTelemetryConfig}), exposes
 * `x-trace-id`/`x-correlation-id` response headers, and records RED
 * metrics (`http.server.requests`, `http.server.request.duration`).
 *
 * Logging is intentionally out of scope — see the SDK's README for why —
 * and so is anything about a request's business meaning; this interceptor
 * only ever sees `ClassName.methodName` as the route label, never the raw
 * URL, to keep metric cardinality bounded.
 */
@Injectable()
export class HttpTraceInterceptor extends BaseTraceInterceptor<HttpSignalContext> {
  private readonly requestsCounter = MetricsService.counter('http.server.requests', { description: 'Total HTTP requests received' });
  private readonly requestDuration = MetricsService.histogram('http.server.request.duration', {
    description: 'HTTP request duration',
    unit: 'ms',
  });

  constructor(@Inject(TELEMETRY_CONFIG) private readonly config: ResolvedTelemetryConfig) {
    super();
  }

  protected supports(context: ExecutionContext): boolean {
    return context.getType() === 'http';
  }

  protected extractSignalContext(context: ExecutionContext): HttpSignalContext {
    const request = context.switchToHttp().getRequest<MinimalRequest>();
    const response = context.switchToHttp().getResponse<MinimalResponse>();
    const route = `${context.getClass().name}.${context.getHandler().name}`;
    return { request, response, route };
  }

  protected shouldIgnore({ request }: HttpSignalContext): boolean {
    const path = request.originalUrl ?? request.url ?? '';
    return isRouteIgnored(path, this.config.ignoreRoutes);
  }

  protected extractCorrelationId({ request }: HttpSignalContext): string | undefined {
    return extractCorrelationId(this.config.correlationIdSources, request.headers, request.body, CorrelationSource.HTTP);
  }

  /**
   * `x-correlation-id` is only reflected back when it contains no CR/LF —
   * the correlation identifier may come straight from attacker-controlled
   * input (a request header or body field), and reflecting it unchecked
   * into a response header would allow response-splitting.
   */
  protected beforeRun({ response }: HttpSignalContext, traceContext: TraceContext): void {
    const setHeader = response.setHeader?.bind(response) ?? response.header?.bind(response);
    setHeader?.('x-trace-id', traceContext.traceId);
    if (traceContext.correlationId && !UNSAFE_HEADER_VALUE_PATTERN.test(traceContext.correlationId)) {
      setHeader?.('x-correlation-id', traceContext.correlationId);
    }
  }

  /**
   * `status_code` reports the literal string `'error'` on failure rather
   * than a number: `response.statusCode` only reflects the mapped error
   * status once the `ExceptionFilter` downstream of this interceptor runs.
   */
  protected recordOutcome({ request, response, route }: HttpSignalContext, outcome: SignalOutcome, durationMs: number): void {
    const attributes = { method: request.method, route, status_code: outcome === 'success' ? response.statusCode : 'error' };
    this.requestsCounter.add(1, attributes);
    this.requestDuration.record(durationMs, attributes);
  }
}
