import { Inject, Injectable, type ExecutionContext } from '@nestjs/common';
import type { SpanContext } from '@opentelemetry/api';
import { extractCorrelationId, CorrelationSource } from '../context/correlation-id-extractor';
import { extractW3CSpanContext, type Carrier } from '../context/w3c-propagation';
import type { ResolvedTelemetryConfig } from '../config/telemetry-config';
import { MetricsService } from '../metrics/metrics.service';
import { TELEMETRY_CONFIG } from '../nestjs/telemetry.tokens';
import { BaseTraceInterceptor, type SignalOutcome } from './base-trace.interceptor';
import { isEventIgnored } from './ignore-matchers';

/** A single AMQP/Kafka header value, in whatever shape the broker client hands it to us. */
type HeaderValue = Buffer | string | number | boolean | (Buffer | string | number | boolean)[] | undefined;

/** Coerces a single header value (Kafka or AMQP) to a string, unwrapping a multi-value array to its first entry. */
function headerValueToString(value: HeaderValue): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return headerValueToString(value[0]);
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return typeof value === 'string' ? value : String(value);
}

/** Builds a lowercase-keyed {@link Carrier} out of a flat header map — shared by the Kafka and RabbitMQ extraction paths below. */
function buildCarrier(headers: Record<string, HeaderValue>): Carrier {
  const carrier: Carrier = {};
  for (const [key, value] of Object.entries(headers)) {
    const stringValue = headerValueToString(value);
    if (stringValue !== undefined) carrier[key.toLowerCase()] = stringValue;
  }
  return carrier;
}

/** Minimal Kafka message shape this interceptor depends on. */
interface MinimalKafkaMessage {
  headers?: Record<string, HeaderValue>;
  offset?: string;
}

/** Minimal shape of `@nestjs/microservices`' `KafkaContext`, as exposed by `switchToRpc().getContext()`. */
interface MinimalKafkaContext {
  getMessage(): MinimalKafkaMessage;
  getTopic(): string;
  getPartition(): number;
}

/** Minimal shape of the raw `amqplib` message `@nestjs/microservices`' `RmqContext.getMessage()` exposes. */
interface MinimalAmqpMessage {
  fields?: { exchange?: string; routingKey?: string };
  properties?: { headers?: Record<string, HeaderValue> };
}

/** Minimal shape of `@nestjs/microservices`' `RmqContext`, as exposed by `switchToRpc().getContext()`. */
interface MinimalRmqContext {
  getMessage(): MinimalAmqpMessage;
  getChannelRef(): unknown;
  getPattern(): string;
}

/**
 * Duck-typed rather than `instanceof`-checked against `@nestjs/microservices`'
 * own classes — avoids a hard dependency on that package purely for a type
 * guard, same reasoning as every other `Minimal*` shape in this file.
 */
function isKafkaContext(value: unknown): value is MinimalKafkaContext {
  const candidate = value as Partial<MinimalKafkaContext> | null;
  return !!candidate && typeof candidate.getTopic === 'function' && typeof candidate.getPartition === 'function';
}

function isRmqContext(value: unknown): value is MinimalRmqContext {
  const candidate = value as Partial<MinimalRmqContext> | null;
  return !!candidate && typeof candidate.getChannelRef === 'function' && typeof candidate.getPattern === 'function';
}

interface KafkaSignalContext {
  broker: 'kafka';
  carrier: Carrier;
  body: unknown;
  topic: string;
  partition: number;
}

interface RabbitMqSignalContext {
  broker: 'rabbitmq';
  carrier: Carrier;
  body: unknown;
  exchange: string;
  routingKey: string;
}

/** Neither Kafka nor RabbitMQ matched — `supports()` already filtered this out, `intercept()` never reaches the other hooks with it. */
interface UnsupportedSignalContext {
  broker: 'unsupported';
  carrier: Carrier;
  body: unknown;
}

type MessageSignalContext = KafkaSignalContext | RabbitMqSignalContext | UnsupportedSignalContext;

/**
 * Message-consumer interceptor for `@nestjs/microservices`' Kafka and
 * RabbitMQ transports — auto-detected per invocation from the shape of the
 * RPC context (`KafkaContext` vs `RmqContext`), so the same interceptor
 * instance instruments both if an application consumes from both. Extracts
 * the `traceparent` header (if present and valid) and re-parents the
 * invocation's trace to it — deliberately explicit rather than relying
 * solely on the broker instrumentation's own context propagation, which has
 * no guarantee of surviving intact through Nest's dispatch pipeline (guards,
 * pipes, RxJS) between the raw message callback and the `@EventPattern`
 * handler. Also resolves the correlation identifier (per {@link
 * ResolvedTelemetryConfig}) and records messaging metrics — separately per
 * broker, since they're different signals in practice:
 * `messaging.kafka.messages_consumed`/`messaging.kafka.processing.duration`
 * (tagged `topic`/`partition`) for Kafka,
 * `messaging.rabbitmq.messages_consumed`/`messaging.rabbitmq.processing.duration`
 * (tagged `exchange`/`routingKey`) for RabbitMQ.
 *
 * Unlike {@link HttpTraceInterceptor} this is not registered globally by
 * `TelemetryModule` — apply it via `@UseInterceptors(...)` on message
 * controllers, since not every application consumes messages. It still
 * reads the same `TELEMETRY_CONFIG` by injection, as `TelemetryModule` is
 * global.
 */
@Injectable()
export class MessageTraceInterceptor extends BaseTraceInterceptor<MessageSignalContext> {
  private readonly kafkaMessagesCounter = MetricsService.counter('messaging.kafka.messages_consumed', {
    description: 'Total Kafka messages consumed',
  });
  private readonly kafkaProcessingDuration = MetricsService.histogram('messaging.kafka.processing.duration', {
    description: 'Kafka message processing duration',
    unit: 'ms',
  });
  private readonly rabbitMqMessagesCounter = MetricsService.counter('messaging.rabbitmq.messages_consumed', {
    description: 'Total RabbitMQ messages consumed',
  });
  private readonly rabbitMqProcessingDuration = MetricsService.histogram('messaging.rabbitmq.processing.duration', {
    description: 'RabbitMQ message processing duration',
    unit: 'ms',
  });

  constructor(@Inject(TELEMETRY_CONFIG) private readonly config: ResolvedTelemetryConfig) {
    super();
  }

  protected supports(context: ExecutionContext): boolean {
    if (context.getType() !== 'rpc') return false;
    const rpcContext = context.switchToRpc().getContext<unknown>();
    return isKafkaContext(rpcContext) || isRmqContext(rpcContext);
  }

  protected extractSignalContext(context: ExecutionContext): MessageSignalContext {
    const rpcContext = context.switchToRpc().getContext<unknown>();
    const body = context.switchToRpc().getData<unknown>();

    if (isKafkaContext(rpcContext)) {
      const carrier = buildCarrier(rpcContext.getMessage().headers ?? {});
      return { broker: 'kafka', carrier, body, topic: rpcContext.getTopic(), partition: rpcContext.getPartition() };
    }

    if (isRmqContext(rpcContext)) {
      const message = rpcContext.getMessage();
      const carrier = buildCarrier(message.properties?.headers ?? {});
      return {
        broker: 'rabbitmq',
        carrier,
        body,
        exchange: message.fields?.exchange ?? '',
        routingKey: message.fields?.routingKey ?? '',
      };
    }

    // Unreachable in practice — supports() already restricted intercept()
    // to contexts matching one of the two shapes above.
    return { broker: 'unsupported', carrier: {}, body };
  }

  protected shouldIgnore({ body, carrier }: MessageSignalContext): boolean {
    return isEventIgnored(this.config.ignoreEvents, body, carrier);
  }

  protected extractCorrelationId({ carrier, body }: MessageSignalContext): string | undefined {
    return extractCorrelationId(this.config.correlationIdSources, carrier, body, CorrelationSource.MESSAGE);
  }

  protected extractRemoteParent({ carrier }: MessageSignalContext): SpanContext | undefined {
    return extractW3CSpanContext(carrier);
  }

  protected recordOutcome(signalContext: MessageSignalContext, outcome: SignalOutcome, durationMs: number): void {
    if (signalContext.broker === 'kafka') {
      const attributes = { topic: signalContext.topic, partition: signalContext.partition, outcome };
      this.kafkaMessagesCounter.add(1, attributes);
      this.kafkaProcessingDuration.record(durationMs, attributes);
      return;
    }

    if (signalContext.broker === 'rabbitmq') {
      const attributes = { exchange: signalContext.exchange, routingKey: signalContext.routingKey, outcome };
      this.rabbitMqMessagesCounter.add(1, attributes);
      this.rabbitMqProcessingDuration.record(durationMs, attributes);
    }
  }
}
