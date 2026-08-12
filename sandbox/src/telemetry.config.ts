/**
 * Configuração única da SDK. `TelemetryModule.forRoot(telemetryConfig)`,
 * em `app.module.ts`, é o único lugar que a consome — ver decisão de
 * arquitetura sobre configuração unificada no claude.md.
 */
import type { TelemetryConfig } from '@snokedll/otel-for-nestjs';

export const telemetryConfig: TelemetryConfig = {
  serviceName: process.env.OTEL_SERVICE_NAME ?? 'billing-simulation',
  // Não é um enum fixo — qualquer string serve. Redireciona dashboards por
  // ambiente num coletor único (ver claude.md).
  environment: process.env.OTEL_DEPLOYMENT_ENVIRONMENT ?? 'sandbox',
  endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://otel-collector:4318',
  protocol: 'http/protobuf',

  // /health é batido pelo HEALTHCHECK do Dockerfile a cada 15s — sem isso,
  // cada uma dessas batidas gera trace context, correlation-id e uma
  // amostra de métrica só de ruído.
  ignoreRoutes: ['/health'],

  // Além do header padrão, aceita correlation-id vindo no corpo de eventos
  // Kafka (ex.: um evento publicado por outro serviço que não usa headers
  // pra isso).
  correlationIdSources: [
    { from: 'header', key: 'x-correlation-id' },
    { from: 'header', key: 'correlation-id' },
    { from: 'body', key: 'correlationId' },
  ],

  // Exemplo de evento a ignorar por critério no corpo — nenhum publisher da
  // simulação emite isso hoje, é só pra deixar o padrão de configuração
  // documentado/testável.
  ignoreEvents: [{ body: { name: 'HEALTH_CHECK' } }],
};
