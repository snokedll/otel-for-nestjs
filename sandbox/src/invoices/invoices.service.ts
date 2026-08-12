import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { Span, Measure, ContinueTrace, MetricsService, captureTraceCarrier, type TraceCarrier } from '@snokedll/otel-for-nestjs';
import { InvoicesEventsPublisher } from './invoices-events.publisher';

interface DelayedProcessingJob {
  invoiceId: string;
  trace: TraceCarrier;
}

export interface Invoice {
  id: string;
  amount: number;
  status: 'pending' | 'processing' | 'paid';
}

@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);
  private readonly invoices = new Map<string, Invoice>([
    ['inv_001', { id: 'inv_001', amount: 199.9, status: 'pending' }],
    ['inv_002', { id: 'inv_002', amount: 49.5, status: 'paid' }],
  ]);

  // `attributes` liga permanentemente esta métrica a um pedaço fixo de
  // contexto (aqui, o módulo de origem) sem repeti-lo em cada `.add()`.
  private readonly invoicesCreatedCounter = MetricsService.counter('invoices.created', {
    description: 'Total de faturas criadas',
    attributes: { module: 'invoices' },
  });
  private readonly invoiceAmountHistogram = MetricsService.histogram('invoices.amount', {
    description: 'Distribuição do valor das faturas criadas',
    unit: 'BRL',
    attributes: { module: 'invoices' },
  });

  constructor(private readonly eventsPublisher: InvoicesEventsPublisher) {
    // Gauge observável: em vez de manter um contador sincronizado à mão a
    // cada mudança de status, só lê o estado que já existe (o Map) no
    // momento em que o Collector faz a coleta.
    MetricsService.observableGauge('invoices.pending.count', (result) => result.observe(this.findAllPending().length), {
      description: 'Quantidade de faturas pendentes agora',
      attributes: { module: 'invoices' },
    });
  }

  @Span()
  findOne(id: string): Invoice {
    this.logger.log('Buscando fatura', { invoiceId: id });
    const invoice = this.invoices.get(id);
    if (!invoice) {
      this.logger.warn('Fatura não encontrada', { invoiceId: id });
      throw new NotFoundException(`Fatura ${id} não encontrada`);
    }
    return invoice;
  }

  /** Usado pelo InvoicesScheduler — roda fora de qualquer requisição HTTP,
   * então sem span pai herdado (ver decisão de arquitetura #2). */
  findAllPending(): Invoice[] {
    return [...this.invoices.values()].filter((invoice) => invoice.status === 'pending');
  }

  create(amount: number): Invoice {
    const id = `inv_${Math.random().toString(36).slice(2, 8)}`;
    const invoice: Invoice = { id, amount, status: 'pending' };
    this.invoices.set(id, invoice);
    this.logger.log('Fatura criada', { invoiceId: id, amount });

    // Sem invoiceId como atributo — é único por chamada, cardinalidade
    // ruim pra métrica (ver aviso em MetricsService). Quem precisar saber
    // QUAL fatura gerou qual ponto usa o log acima ou o trace, não isto.
    this.invoicesCreatedCounter.add(1);
    this.invoiceAmountHistogram.record(amount);

    this.eventsPublisher.publishInvoiceCreated(invoice);
    return invoice;
  }

  /**
   * @Span cria um span filho nomeado — útil pra amostra individual
   * detalhada. @Measure grava a métrica agregada (calls + duration) em
   * cima do mesmo método — as duas juntas cobrem os dois casos de uso:
   * "o que aconteceu NESSA chamada" (trace) vs. "como está a p95 disso
   * na última hora" (métrica, mais barata de reter por muito tempo).
   */
  @Span('invoice.process-payment')
  @Measure('invoice.process-payment')
  async process(id: string): Promise<Invoice> {
    const invoice = this.findOne(id);
    this.logger.log('Iniciando processamento de pagamento', { invoiceId: id });

    await this.checkFraud(id);

    await new Promise((resolve) => setTimeout(resolve, 150));
    invoice.status = 'paid';

    this.logger.log('Pagamento processado com sucesso', { invoiceId: id, amount: invoice.amount });
    return invoice;
  }

  @Span('invoice.fraud-check')
  private async checkFraud(id: string): Promise<void> {
    this.logger.debug('Executando checagem de fraude', { invoiceId: id });
    await new Promise((resolve) => setTimeout(resolve, 80));
  }

  /**
   * Demonstra continuidade de trace em processamento assíncrono: o
   * `setTimeout` abaixo é só o mecanismo mais simples possível pra simular
   * o "gap" — na prática seria um `queue.add()` do Bull/BullMQ, um
   * `publish` no RabbitMQ, um `producer.send()` no Kafka, etc. O trace é
   * capturado aqui, ainda dentro da requisição, e passado como parte do
   * job pra `processDelayedJob` — o `@ContinueTrace()` naquele método
   * cuida do resto.
   */
  scheduleDelayedProcessing(id: string, delayMs = 1000): void {
    const job: DelayedProcessingJob = { invoiceId: id, trace: captureTraceCarrier() };
    this.logger.log('Processamento assíncrono agendado', { invoiceId: id, delayMs });

    setTimeout(() => {
      this.processDelayedJob(job).catch((error: unknown) => {
        this.logger.error('Falha no processamento assíncrono agendado', error as Error, { invoiceId: id });
      });
    }, delayMs);
  }

  @ContinueTrace('invoice.delayed-processing')
  private async processDelayedJob({ invoiceId }: DelayedProcessingJob): Promise<void> {
    this.logger.log('Processamento assíncrono iniciado (mesmo trace da requisição original)', { invoiceId });
    await this.process(invoiceId);
  }

  /** Endpoint de demonstração: lança um erro deliberadamente. */
  fail(id: string): never {
    this.logger.error(
      'Falha simulada ao processar fatura',
      new Error('Gateway de pagamento indisponível'),
      { invoiceId: id },
    );
    throw new Error('Gateway de pagamento indisponível');
  }
}
