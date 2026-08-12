import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Span } from '@snokedll/otel-for-nestjs';
import { InvoicesService } from './invoices.service';

/**
 * Job de fundo — dispara sozinho, sem nenhuma requisição HTTP por trás.
 * É o caso interessante pra ver o fallback de traceId sintético em ação
 * (decisão de arquitetura #2 do claude.md): não existe span ativo herdado
 * de request nenhum, então o `@Span` abaixo abre uma raiz de trace NOVA a
 * cada execução — cada rodada do cron vira sua própria trace isolada no
 * Tempo, sem relação com nenhuma requisição HTTP.
 */
@Injectable()
export class InvoicesScheduler {
  private readonly logger = new Logger(InvoicesScheduler.name);

  constructor(private readonly invoicesService: InvoicesService) {}

  @Cron(CronExpression.EVERY_10_SECONDS)
  @Span('invoices.reconcile-pending')
  async reconcilePending(): Promise<void> {
    const pending = this.invoicesService.findAllPending();

    if (pending.length === 0) {
      this.logger.debug('Reconciliação: nenhuma fatura pendente');
      return;
    }

    this.logger.log('Reconciliação: processando faturas pendentes', { count: pending.length });
    for (const invoice of pending) {
      await this.invoicesService.process(invoice.id);
    }
  }
}
