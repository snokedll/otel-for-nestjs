import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { InvoicesService, type Invoice } from './invoices.service';
import { Span } from '@snokedll/otel-for-nestjs';

@Controller('invoices')
export class InvoicesController {
  constructor(private readonly invoicesService: InvoicesService) {}

  @Get(':id')
  @Span()
  findOne(@Param('id') id: string): Invoice {
    return this.invoicesService.findOne(id);
  }

  @Post()
  create(@Body('amount') amount: number): Invoice {
    return this.invoicesService.create(amount);
  }

  @Post(':id/process')
  process(@Param('id') id: string): Promise<Invoice> {
    return this.invoicesService.process(id);
  }

  /** Dispara o processamento de forma assíncrona (fora do ciclo de vida
   * desta requisição) mas mantendo o mesmo trace id — ver
   * `captureTraceCarrier`/`@ContinueTrace` em invoices.service.ts. */
  @Post(':id/process-delayed')
  processDelayed(@Param('id') id: string): { scheduled: true } {
    this.invoicesService.scheduleDelayedProcessing(id);
    return { scheduled: true };
  }

  @Get(':id/fail')
  fail(@Param('id') id: string): never {
    return this.invoicesService.fail(id);
  }
}
