import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { InvoicesController } from './invoices.controller';
import { InvoicesEventsController } from './invoices-events.controller';
import { InvoicesEventsPublisher, INVOICE_EVENTS_CLIENT } from './invoices-events.publisher';
import { InvoicesScheduler } from './invoices.scheduler';
import { InvoicesService } from './invoices.service';

const kafkaBrokers = (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',');

@Module({
  imports: [
    ClientsModule.register([
      {
        name: INVOICE_EVENTS_CLIENT,
        transport: Transport.KAFKA,
        options: {
          client: { clientId: 'billing-simulation-producer', brokers: kafkaBrokers },
          producer: { allowAutoTopicCreation: true },
        },
      },
    ]),
  ],
  controllers: [InvoicesController, InvoicesEventsController],
  providers: [InvoicesService, InvoicesEventsPublisher, InvoicesScheduler],
})
export class InvoicesModule {}
