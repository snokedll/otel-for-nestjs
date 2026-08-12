import { Controller, Logger, UseInterceptors } from '@nestjs/common';
import { Ctx, EventPattern, KafkaContext, Payload } from '@nestjs/microservices';
import { MessageTraceInterceptor, Span } from '@snokedll/otel-for-nestjs';
import { MessageLoggingInterceptor } from '../common/message-logging.interceptor';
import { INVOICE_CREATED_TOPIC } from './invoices-events.publisher';

interface InvoiceCreatedPayload {
  id: string;
  amount: number;
}

/**
 * Consumer do evento `invoice.created`. `MessageTraceInterceptor` extrai o
 * traceparent/correlationId dos headers e roda o handler dentro desse
 * contexto — então tanto o `Logger` quanto o `@Span` abaixo já enxergam o
 * trace da requisição HTTP original que criou a fatura, não um trace novo.
 */
@Controller()
@UseInterceptors(MessageTraceInterceptor, MessageLoggingInterceptor)
export class InvoicesEventsController {
  private readonly logger = new Logger(InvoicesEventsController.name);

  // O KafkaParser do @nestjs/microservices já decodifica e faz JSON.parse
  // do value da mensagem antes de chegar aqui (ver decode() em
  // kafka-parser.js: qualquer value começando com `{`/`[` vira objeto
  // automaticamente) — @Payload() já entrega o objeto, não o Buffer cru.
  @EventPattern(INVOICE_CREATED_TOPIC)
  @Span('invoice.created.consume')
  async handleInvoiceCreated(@Payload() invoice: InvoiceCreatedPayload, @Ctx() context: KafkaContext): Promise<void> {
    this.logger.log('Notificando cliente sobre nova fatura (simulado)', {
      invoiceId: invoice.id,
      amount: invoice.amount,
      partition: context.getPartition(),
    });

    // Simula uma chamada externa (ex.: serviço de e-mail/notificação).
    await new Promise((resolve) => setTimeout(resolve, 60));

    this.logger.log('Notificação enviada', { invoiceId: invoice.id });
  }
}
