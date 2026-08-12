import { Injectable, Logger, type NestInterceptor, type ExecutionContext, type CallHandler } from '@nestjs/common';
import type { KafkaContext } from '@nestjs/microservices';
import { isEventIgnored, type EventIgnoreRule } from '@snokedll/otel-for-nestjs';
import { Observable, tap } from 'rxjs';

// Lista PRÓPRIA da aplicação — mesmo espírito de IGNORED_LOG_ROUTES em
// HttpLoggingInterceptor. `ignoreEvents` da SDK (em app.module.ts) decide o
// que NÃO vira trace/correlation-id/métrica; esta decide o que NÃO vira
// log. `MessageTraceInterceptor` NÃO corta a cadeia quando ignora um evento
// — ele só pula a própria instrumentação e delega pra `next.handle()`, que
// ainda chama este interceptor normalmente. Por isso o mesmo critério
// precisa ser repetido aqui se quiser o mesmo comportamento pro log.
const IGNORED_LOG_EVENTS: EventIgnoreRule[] = [{ body: { name: 'HEALTH_CHECK' } }];

/**
 * Logging de ciclo de vida de mensagem Kafka — mesma decisão do
 * `HttpLoggingInterceptor`: responsabilidade da aplicação, não da SDK. Ver
 * o comentário lá pro porquê.
 *
 * Aplicado em `@UseInterceptors(MessageTraceInterceptor, MessageLoggingInterceptor)`
 * — nessa ordem: `MessageTraceInterceptor` primeiro (extrai trace/
 * correlation-id), e só então este interceptor, que já roda dentro do
 * contexto preparado por ele.
 */
@Injectable()
export class MessageLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(MessageLoggingInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'rpc') return next.handle();

    const body = context.switchToRpc().getData<unknown>();
    const kafkaContext = context.switchToRpc().getContext<KafkaContext>();
    const topic = kafkaContext.getTopic();
    const partition = kafkaContext.getPartition();
    const offset = kafkaContext.getMessage().offset;

    if (isEventIgnored(IGNORED_LOG_EVENTS, body, {})) return next.handle();

    const startTime = Date.now();

    this.logger.log('Mensagem recebida', { topic, partition, offset });

    return next.handle().pipe(
      tap({
        next: () => {
          this.logger.log('Mensagem processada', { topic, partition, offset, durationMs: Date.now() - startTime });
        },
        error: (err: Error) => {
          this.logger.error('Falha ao processar mensagem', err, {
            topic,
            partition,
            offset,
            durationMs: Date.now() - startTime,
          });
        },
      }),
    );
  }
}
