import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { type MicroserviceOptions, Transport } from '@nestjs/microservices';
import { Kafka } from 'kafkajs';
import { TraceLogger } from '@snokedll/otel-for-nestjs';
import { AppModule } from './app.module';
import { INVOICE_CREATED_TOPIC } from './invoices/invoices-events.publisher';

const kafkaBrokers = (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',');

/**
 * Cria o(s) tópico(s) explicitamente ANTES de conectar consumer/producer.
 *
 * Sem isso: a primeira metadata request pro tópico ainda inexistente
 * dispara auto-criação no broker (`auto.create.topics.enable`), mas o
 * Kafka responde `UNKNOWN_TOPIC_OR_PARTITION` NESSA MESMA request (erro
 * transiente, esperado — a criação ainda está em andamento) — e o kafkajs
 * não engole esse erro sozinho aqui, ele sobe e derruba o boot da app.
 * `createTopics()` não lança se o tópico já existir, só retorna `false`.
 */
async function ensureKafkaTopics(): Promise<void> {
  const admin = new Kafka({ clientId: 'billing-simulation-admin', brokers: kafkaBrokers }).admin();
  await admin.connect();
  try {
    await admin.createTopics({ topics: [{ topic: INVOICE_CREATED_TOPIC, numPartitions: 1, replicationFactor: 1 }] });
  } finally {
    await admin.disconnect();
  }
}

async function bootstrap(): Promise<void> {
  // bufferLogs adia os logs de bootstrap do Nest até o useLogger() abaixo
  // ser aplicado — sem isso, tudo que acontece antes do useLogger() sai
  // pelo logger padrão do Nest, não correlacionado e fora do OTel.
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(new TraceLogger());

  await ensureKafkaTopics();

  // App híbrida: HTTP (Express) + microservice Kafka no mesmo processo e
  // mesmo container Nest — os controllers com @EventPattern (ver
  // InvoicesEventsController) são servidos por essa conexão, não pelo
  // adapter HTTP.
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.KAFKA,
    options: {
      client: { clientId: 'billing-simulation-consumer', brokers: kafkaBrokers },
      consumer: { groupId: 'billing-simulation' },
    },
  });
  await app.startAllMicroservices();

  const logger = new Logger('bootstrap');
  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  logger.log(`billing-simulation ouvindo na porta ${port}`, { port });
}

void bootstrap();
