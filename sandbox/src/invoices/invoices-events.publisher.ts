import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientKafka } from '@nestjs/microservices';
import { injectW3CTraceParent, TraceContextManager } from '@snokedll/otel-for-nestjs';
import type { Invoice } from './invoices.service';

export const INVOICE_EVENTS_CLIENT = 'INVOICE_EVENTS_CLIENT';
export const INVOICE_CREATED_TOPIC = 'invoice.created';

/**
 * Publica eventos de domínio no Kafka. O ponto interessante aqui é o
 * `injectW3CTraceParent`: grava o `traceparent` do span ATIVO nesse exato
 * momento (o span da requisição HTTP que criou a fatura) nos headers da
 * mensagem — é isso que permite o `MessageTraceInterceptor`, do lado do
 * consumer, linkar o processamento como filho do MESMO trace, mesmo essa
 * mensagem sendo processada minutos depois, em outro ciclo de I/O
 * completamente desconectado da requisição original.
 */
@Injectable()
export class InvoicesEventsPublisher {
  private readonly logger = new Logger(InvoicesEventsPublisher.name);

  constructor(@Inject(INVOICE_EVENTS_CLIENT) private readonly client: ClientKafka) {}

  publishInvoiceCreated(invoice: Invoice): void {
    const headers: Record<string, string> = {};
    injectW3CTraceParent(headers);

    const correlationId = TraceContextManager.getCorrelationId();
    if (correlationId) headers['x-correlation-id'] = correlationId;

    this.client.emit(INVOICE_CREATED_TOPIC, { key: invoice.id, value: invoice, headers }).subscribe({
      error: (err: unknown) =>
        this.logger.error('Falha ao publicar evento invoice.created', err as Error, { invoiceId: invoice.id }),
    });

    this.logger.log('Evento invoice.created publicado', { invoiceId: invoice.id, topic: INVOICE_CREATED_TOPIC });
  }
}
