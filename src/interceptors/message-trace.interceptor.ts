import { Inject, Injectable, type ExecutionContext } from '@nestjs/common';
import type { SpanContext } from '@opentelemetry/api';
import { extractCorrelationId, CorrelationSource } from '../context/correlation-id-extractor';
import { extractW3CSpanContext, type Carrier } from '../context/w3c-propagation';
import type { ResolvedTelemetryConfig } from '../config/telemetry-config';
import { MetricsService } from '../metrics/metrics.service';
import { TELEMETRY_CONFIG } from '../nestjs/telemetry.tokens';
import { BaseTraceInterceptor, type SignalOutcome } from './base-trace.interceptor';
import { isEventIgnored } from './ignore-matchers';

type KafkaHeaderValue = Buffer | string | (Buffer | string)[] | undefined;

/** Minimal Kafka message headers shape — avoids a hard dependency on `kafkajs`. */
interface MinimalKafkaHeaders {
  [key: string]: KafkaHeaderValue;
}

/** Minimal Kafka message shape this interceptor depends on. */
interface MinimalKafkaMessage {
  headers?: MinimalKafkaHeaders;
  offset?: string;
}

/** Minimal shape of `@nestjs/microservices`' `KafkaContext`, as exposed by `switchToRpc().getContext()`. */
interface MinimalKafkaContext {
  getMessage(): MinimalKafkaMessage;
  getTopic(): string;
  getPartition(): number;
}

interface KafkaSignalContext {
  carrier: Carrier;
  body: unknown;
  topic: string;
  partition: number;
}

function headerToString(value: KafkaHeaderValue): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return headerToString(value[0]);
  return Buffer.isBuffer(value) ? value.toString('utf8') : value;
}

function buildCarrier(headers: MinimalKafkaHeaders): Carrier {
  const carrier: Carrier = {};
  for (const [key, value] of Object.entries(headers)) {
    const stringValue = headerToString(value);
    if (stringValue !== undefined) carrier[key.toLowerCase()] = stringValue;
  }
  return carrier;
}

/**
 * Message-consumer interceptor for `@nestjs/microservices`' Kafka
 * transport. Extracts the `traceparent` header (if present and valid) and
 * re-parents the invocation's trace to it — deliberately explicit rather
 * than relying solely on `instrumentation-kafkajs`'s own context
 * propagation, which has no guarantee of surviving intact through Nest's
 * dispatch pipeline (guards, pipes, RxJS) between `eachMessage` and the
 * `@EventPattern` handler. Also resolves the correlation identifier (per
 * {@link ResolvedTelemetryConfig}) and records messaging metrics
 * (`messaging.kafka.messages_consumed`, `messaging.kafka.processing.duration`).
 *
 * Unlike {@link HttpTraceInterceptor} this is not registered globally by
 * `TelemetryModule` — apply it via `@UseInterceptors(...)` on Kafka
 * controllers, since not every application consumes messages. It still
 * reads the same `TELEMETRY_CONFIG` by injection, as `TelemetryModule` is
 * global.
 */
@Injectable()
export class MessageTraceInterceptor extends BaseTraceInterceptor<KafkaSignalContext> {
  private readonly messagesCounter = MetricsService.counter('messaging.kafka.messages_consumed', {
    description: 'Total Kafka messages consumed',
  });
  private readonly processingDuration = MetricsService.histogram('messaging.kafka.processing.duration', {
    description: 'Kafka message processing duration',
    unit: 'ms',
  });

  constructor(@Inject(TELEMETRY_CONFIG) private readonly config: ResolvedTelemetryConfig) {
    super();
  }

  protected supports(context: ExecutionContext): boolean {
    return context.getType() === 'rpc';
  }

  protected extractSignalContext(context: ExecutionContext): KafkaSignalContext {
    const kafkaContext = context.switchToRpc().getContext<MinimalKafkaContext>();
    const body = context.switchToRpc().getData<unknown>();
    const carrier = buildCarrier(kafkaContext.getMessage().headers ?? {});
    return { carrier, body, topic: kafkaContext.getTopic(), partition: kafkaContext.getPartition() };
  }

  protected shouldIgnore({ body, carrier }: KafkaSignalContext): boolean {
    return isEventIgnored(this.config.ignoreEvents, body, carrier);
  }

  protected extractCorrelationId({ carrier, body }: KafkaSignalContext): string | undefined {
    return extractCorrelationId(this.config.correlationIdSources, carrier, body, CorrelationSource.MESSAGE);
  }

  protected extractRemoteParent({ carrier }: KafkaSignalContext): SpanContext | undefined {
    return extractW3CSpanContext(carrier);
  }

  protected recordOutcome({ topic, partition }: KafkaSignalContext, outcome: SignalOutcome, durationMs: number): void {
    const attributes = { topic, partition, outcome };
    this.messagesCounter.add(1, attributes);
    this.processingDuration.record(durationMs, attributes);
  }
}
