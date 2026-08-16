# @snokedll/otel-for-nestjs

Observability SDK for NestJS applications, built on top of the
OpenTelemetry Node.js SDK.

## Description

From a single configuration, the SDK provides:

- OpenTelemetry SDK initialization (HTTP, Express, Kafka, database, and
  other supported library auto-instrumentation) and export of logs,
  traces, and metrics via OTLP.
- Automatic trace-id and correlation-id propagation on HTTP requests and
  consumed events, reflected in response headers (`x-trace-id`,
  `x-correlation-id`).
- `TraceLogger`, a NestJS `LoggerService` that correlates every log
  emitted by the application (and by the framework itself) to the active
  trace/correlation-id.
- `@Span()` and `@Measure()` decorators for manual method instrumentation.
- `MetricsService`, a facade over the OpenTelemetry Metrics API
  (counters, histograms, up-down-counters, observable gauges).
- Environment attribute (`deployment.environment.name`) on traces, logs,
  and metrics, freely configurable (`staging`, `production`, etc.).
- Trace-id/correlation-id continuity across asynchronous processing
  (queues, `setTimeout`, scheduled jobs), independent of the technology
  used.
- Kafka event interceptor (`MessageTraceInterceptor`) for correlating
  consumed messages.
- Metric cardinality controls, header injection prevention, and
  prototype pollution prevention when extracting correlation-id.

The SDK does not perform logging on its own: it only correlates logs
emitted by the application.

## Compatibility

| Requirement | Supported version |
|---|---|
| Node.js | `>= 22.0.0` |
| NestJS | `^9.0.0 \|\| ^10.0.0 \|\| ^11.0.0` |
| TypeScript | `>= 4.9.0`, with `experimentalDecorators` and `emitDecoratorMetadata` enabled |
| Module | CommonJS and ESM |

## Installation

```bash
npm install @snokedll/otel-for-nestjs
```

## Local testing

The repository includes an automated test suite and a local testing
environment (`sandbox/`), intended for anyone forking or contributing to
the project.

### SDK test suite

```bash
npm install
npm test               # runs the suite
npm run test:watch     # watch mode
npm run test:coverage  # with coverage report
npm run type-check     # type checking
```

### Local testing environment (`sandbox/`)

Example NestJS application consuming the SDK, included for manual
validation during development. Usage instructions are in
`sandbox/README.md`.

## Implementing the SDK

### Configuration

```typescript
// telemetry.config.ts
import type { TelemetryConfig } from '@snokedll/otel-for-nestjs';

export const telemetryConfig: TelemetryConfig = {
  serviceName: 'billing-service',
  environment: process.env.NODE_ENV,
  endpoint: 'http://otel-collector:4318',
  ignoreRoutes: ['/health'],
};
```

```typescript
// app.module.ts
import { Module } from '@nestjs/common';
import { TelemetryModule } from '@snokedll/otel-for-nestjs';
import { telemetryConfig } from './telemetry.config';

@Module({
  imports: [TelemetryModule.forRoot(telemetryConfig)],
})
export class AppModule {}
```

`TelemetryModule.forRoot()` initializes the OpenTelemetry SDK and
registers the application's interceptors. No further configuration is
required.

#### `TelemetryConfig` fields

| Field | Type | Default | Description |
|---|---|---|---|
| `serviceName` | `string` | — (required) | Reported as the `service.name` attribute on every trace, log, and metric. |
| `environment` | `string` | not set | Reported as the `deployment.environment.name` attribute. Free-form value (`staging`, `production`, `sandbox`, etc.), not a fixed enum. If omitted, no environment attribute is reported. |
| `endpoint` | `string` | not set | OTel Collector URL, OTLP/HTTP format (e.g. `http://otel-collector:4318`). Used by any enabled signal that does not define its own `endpoint`. |
| `protocol` | `'http/json' \| 'http/protobuf'` | `'http/protobuf'` | OTLP serialization format used when exporting every signal. |
| `logs` | `{ enabled?: boolean; endpoint?: string }` | `{ enabled: true }` | Logs signal configuration. `endpoint`, if set, overrides `endpoint` for this signal only. |
| `traces` | `{ enabled?: boolean; endpoint?: string }` | `{ enabled: true }` | Traces signal configuration. |
| `metrics` | `{ enabled?: boolean; endpoint?: string }` | `{ enabled: true }` | Metrics signal configuration. |
| `correlationIdSources` | `CorrelationIdSource[]` | `x-correlation-id`, `correlation-id`, `correlationId` headers, in this order | Locations searched for the correlation-id. See [Correlation-id source](#correlation-id-source). |
| `ignoreRoutes` | `RoutePattern[]` (`string \| RegExp`) | `[]` | HTTP routes for which no trace, correlation-id, or metric is generated. |
| `ignoreEvents` | `EventIgnoreRule[]` | `[]` | Consumed events, identified by partial match on the message body and/or headers, for which no trace, correlation-id, or metric is generated. |

### Correlation-id source

`correlationIdSources` is evaluated in order; the first non-empty value
found is used as the correlation-id. The same list is applied both to
HTTP requests (`HttpTraceInterceptor`) and to consumed events
(`MessageTraceInterceptor`), regardless of the configured messaging
technology.

```typescript
correlationIdSources: [
  { from: 'header', key: 'x-correlation-id' },
  { from: 'body', key: 'metadata.correlationId' },
]
```

- `from: 'header'` reads a header, case-insensitive — from an HTTP
  request or a message, depending on the transport being processed.
- `from: 'body'` reads a dot-notation path (e.g.
  `'metadata.correlationId'`) from the already-deserialized request or
  message body.

To restrict an entry to a single transport, use the `source` field with
the `CorrelationSource` enum. Entries without `source` are evaluated for
both transports.

```typescript
import { CorrelationSource } from '@snokedll/otel-for-nestjs';

correlationIdSources: [
  { from: 'header', key: 'x-correlation-id', source: CorrelationSource.HTTP },
  { from: 'body', key: 'eventId', source: CorrelationSource.MESSAGE },
]
```

### Ignored routes and events

```typescript
TelemetryModule.forRoot({
  serviceName: 'billing-service',
  ignoreRoutes: ['/health', /^\/internal\//],
  ignoreEvents: [{ body: { name: 'HEALTH_CHECK' } }],
});
```

### Logging

```typescript
// main.ts
const app = await NestFactory.create(AppModule, { bufferLogs: true });
app.useLogger(new TraceLogger());
```

After this configuration, NestJS's default `Logger` is already
correlated automatically, with no further changes needed in the
application's services.

`TraceLogger`'s constructor accepts two optional positional arguments:
`context` (prefixed onto every log call unless overridden per-call) and
`consoleLevel` (minimum level written to the console — `'debug' |
'info' | 'warn' | 'error' | 'fatal'`, defaults to `'info'`). This only
affects the console output; every call still emits a `LogRecord` via the
OpenTelemetry Logs API regardless of `consoleLevel`.

```typescript
app.useLogger(new TraceLogger(undefined, 'debug'));
```

### `@Span()` and `@Measure()` decorators

```typescript
class InvoicesService {
  @Span('invoice.process-payment')
  @Measure('invoice.process-payment')
  async process(id: string) { ... }
}
```

`@Span()` creates a named span. `@Measure()` records a call counter and
a duration histogram. The order between the decorators, and between them
and NestJS's own decorators, is irrelevant.

### Metrics

```typescript
import { MetricsService } from '@snokedll/otel-for-nestjs';

private readonly invoicesCreatedCounter = MetricsService.counter('invoices.created', {
  description: 'Total invoices created',
  attributes: { module: 'invoices' },
});

this.invoicesCreatedCounter.add(1, { outcome: 'success' });
```

`attributes` must contain low-cardinality values only.

### Searching by correlation-id

Every active span is tagged with the `app.correlation_id` attribute
whenever a correlation-id is resolved, enabling search via TraceQL:

```
{ span.app.correlation_id = "order-123" }
```

### Trace continuity across asynchronous processing

```typescript
import { captureTraceCarrier, ContinueTrace, type TraceCarrier } from '@snokedll/otel-for-nestjs';

// At the point where asynchronous processing is scheduled
const trace = captureTraceCarrier();
await queue.add('charge-invoice', { invoiceId, trace });
```

```typescript
// On the processing consumer
class InvoiceProcessor {
  @ContinueTrace('invoice.charge')
  async process(job: { invoiceId: string; trace: TraceCarrier }) {
    // runs with the same trace-id and correlation-id as the original request
  }
}
```

`captureTraceCarrier()` returns a plain, serializable object, meant to be
included in the job payload — independent of the queue technology used
(Bull, RabbitMQ, Kafka, scheduling, etc.). `@ContinueTrace()` reads the
`trace` field off the method's first argument by default; the
`extractCarrier` option allows for a different payload shape.

### Consuming events

```typescript
@Controller()
@UseInterceptors(MessageTraceInterceptor)
export class InvoicesEventsController {
  @EventPattern('invoice.created')
  async handle(@Payload() data: unknown) { ... }
}
```

## License

[MIT + Commons Clause](LICENSE).

Use, modification, forking, and contribution are free, including
commercial use as a dependency of any project or product. Selling the
SDK itself — reselling the code, or offering a hosted service whose
value derives substantially from the SDK — is not permitted.
