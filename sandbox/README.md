# Sandbox

Aplicação NestJS de exemplo, usada para validação manual da SDK
`@snokedll/otel-for-nestjs` durante o desenvolvimento. Destinada a quem for
realizar fork ou contribuir com o projeto.

## Estrutura

```
sandbox/
├── src/                    # controllers/services de exemplo (domínio de faturas)
│   └── telemetry.config.ts    # configuração passada a TelemetryModule.forRoot()
└── docker/                 # stack de observabilidade completo
    ├── docker-compose.yml
    ├── otel-collector-config.yaml
    ├── tempo.yaml
    ├── loki-config.yaml
    ├── prometheus.yml
    └── grafana/provisioning/
```

## Executando sem Docker

```bash
# Build da SDK
npm install
npm run build

# Build e execução da sandbox
cd sandbox
npm install
npm run build
npm start
```

Sem um Collector ou broker Kafka acessíveis, os exporters e o client Kafka
falham ao conectar (com retry em background), mas a aplicação continua
operando normalmente.

Para testar com Collector e Kafka reais, sem subir o restante do stack:

```bash
docker compose -f sandbox/docker/docker-compose.yml up -d kafka otel-collector
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 KAFKA_BROKERS=localhost:9092 npm start
```

## Executando o stack completo com Docker

```bash
docker compose -f sandbox/docker/docker-compose.yml up --build
```

| Serviço | URL | Observação |
|---|---|---|
| Aplicação de exemplo | http://localhost:3001 | |
| Grafana | http://localhost:3000 | `admin` / `admin` |
| Prometheus | http://localhost:9090 | |
| Tempo (API) | http://localhost:3200 | |
| Loki (API) | http://localhost:3100 | |

### Endpoints de exemplo

```bash
curl http://localhost:3001/invoices/inv_001

curl http://localhost:3001/invoices/inv_001 -H "x-correlation-id: teste-manual-123"

curl -X POST http://localhost:3001/invoices -H "Content-Type: application/json" -d '{"amount": 250}'

curl -X POST http://localhost:3001/invoices/inv_001/process

curl -X POST http://localhost:3001/invoices/inv_001/process-delayed

curl http://localhost:3001/invoices/inv_999/fail
```

### Explorando no Grafana

1. Acesse http://localhost:3000 (`admin`/`admin`).
2. Selecione **Explore** e o datasource **Tempo**.
3. Busque por `{ resource.service.name = "billing-simulation" }` ou
   `{ span.app.correlation_id = "teste-manual-123" }` (TraceQL).
4. A partir de um span, utilize **Logs for this span** para acessar os
   logs correlacionados no Loki.
5. Troque para o datasource **Prometheus** para consultar métricas.

## Encerrando o ambiente

```bash
docker compose -f sandbox/docker/docker-compose.yml down -v
```
