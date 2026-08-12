import { Injectable, Logger, type NestInterceptor, type ExecutionContext, type CallHandler } from '@nestjs/common';
import { isRouteIgnored } from '@snokedll/otel-for-nestjs';
import { Observable, tap } from 'rxjs';

interface MinimalRequest {
  method: string;
  url?: string;
  originalUrl?: string;
}

interface MinimalResponse {
  statusCode: number;
}

// Lista PRÓPRIA da aplicação, não importada da config do TelemetryModule —
// de propósito. `ignoreRoutes` da SDK decide o que NÃO vira trace/métrica;
// esta lista decide o que NÃO vira log. As duas listas podem divergir (ex.:
// uma app pode querer métrica de /health mas não log, ou vice-versa) — por
// isso `isRouteIgnored` é exportado como utilitário reaproveitável em vez
// de embutido só na config da SDK.
const IGNORED_LOG_ROUTES = ['/health'];

/**
 * Logging de ciclo de vida de requisição HTTP — responsabilidade da
 * APLICAÇÃO, não da SDK. `HttpTraceInterceptor` (da SDK) só cuida de
 * trace/correlation-id/métricas; decidir SE e O QUE logar é decisão de
 * produto, não de infraestrutura de telemetria.
 *
 * Registrado em app.module.ts como `APP_INTERCEPTOR` DEPOIS de
 * `TelemetryModule.forRoot()` — por isso roda "dentro" do contexto que a
 * SDK já preparou (`TraceContextManager.run()`), e não precisa reimplementar
 * nenhuma parte disso: um `tap()` simples já loga com traceId/correlationId
 * corretos, porque o `Logger`/`TraceLogger` lê esse contexto sozinho.
 */
@Injectable()
export class HttpLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(HttpLoggingInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const request = context.switchToHttp().getRequest<MinimalRequest>();
    const path = request.originalUrl ?? request.url ?? 'desconhecido';
    if (isRouteIgnored(path, IGNORED_LOG_ROUTES)) return next.handle();

    const response = context.switchToHttp().getResponse<MinimalResponse>();
    const startTime = Date.now();

    this.logger.log('Requisição recebida', { method: request.method, path });

    return next.handle().pipe(
      tap({
        next: () => {
          this.logger.log('Requisição concluída', {
            method: request.method,
            path,
            statusCode: response.statusCode,
            durationMs: Date.now() - startTime,
          });
        },
        error: (err: Error) => {
          this.logger.error('Requisição falhou', err, {
            method: request.method,
            path,
            durationMs: Date.now() - startTime,
          });
        },
      }),
    );
  }
}
