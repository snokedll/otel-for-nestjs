import pino, { type Logger as PinoLogger } from 'pino';
import { logs, SeverityNumber, type Logger as OtelLogger, type LogAttributes } from '@opentelemetry/api-logs';
import type { LoggerService } from '@nestjs/common';
import { TraceContextManager, CORRELATION_ID_ATTRIBUTE } from '../context/trace-context';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/**
 * Structured metadata accepted by {@link TraceLogger} — the same shape
 * OpenTelemetry accepts as attributes (strings, numbers, booleans, and
 * nested arrays/maps of those).
 */
export type LogMetadata = LogAttributes;

/** Matches a real multi-line stack trace (`message\n    at file:line:col`), as opposed to a bare context string. */
const STACK_TRACE_PATTERN = /^(.)+\n\s+at .+:\d+:\d+/;

const SEVERITY_BY_LEVEL: Record<LogLevel, SeverityNumber> = {
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
  fatal: SeverityNumber.FATAL,
};

interface ParsedCallArgs {
  metadata?: LogMetadata;
  context?: string;
}

interface ParsedErrorCallArgs extends ParsedCallArgs {
  error?: Error;
}

function createPinoLogger(level: LogLevel): PinoLogger {
  return pino({
    level,
    serializers: { err: pino.stdSerializers.err },
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, singleLine: false, ignore: 'pid,hostname', translateTime: 'SYS:standard' },
    },
  });
}

/**
 * Splits Nest-style call arguments (`message, ...optionalParams`) into
 * structured metadata and an optional context override — the last string
 * argument becomes `context`, any object arguments are merged as metadata.
 */
function parseCallArgs(optionalParams: unknown[]): ParsedCallArgs {
  let metadata: LogMetadata | undefined;
  let context: string | undefined;

  for (const param of optionalParams) {
    if (typeof param === 'string') {
      context = param;
    } else if (param && typeof param === 'object') {
      metadata = { ...metadata, ...(param as LogMetadata) };
    }
  }

  return { metadata, context };
}

/**
 * Same as {@link parseCallArgs}, additionally recognizing an `Error`
 * instance or a raw stack-trace string (Nest's `error(message, stack,
 * context?)` convention, detected via {@link STACK_TRACE_PATTERN}) among
 * the arguments.
 */
function parseErrorCallArgs(message: unknown, optionalParams: unknown[]): ParsedErrorCallArgs {
  let error: Error | undefined;
  let metadata: LogMetadata | undefined;
  let context: string | undefined;

  for (const param of optionalParams) {
    if (param instanceof Error) {
      error = param;
    } else if (typeof param === 'string') {
      if (STACK_TRACE_PATTERN.test(param)) {
        error = Object.assign(new Error(String(message)), { stack: param });
      } else {
        context = param;
      }
    } else if (param && typeof param === 'object') {
      metadata = { ...metadata, ...(param as LogMetadata) };
    }
  }

  return { error, metadata, context };
}

/**
 * The SDK's sole logger. Every call writes to two destinations at once:
 * pino, for a human-readable console line, and the OpenTelemetry Logs API,
 * emitting a `LogRecord` exported to the Collector when logs are enabled.
 *
 * Implements Nest's {@link LoggerService}, so an instance can be installed
 * as the application's logger via `app.useLogger(new TraceLogger())` —
 * from then on the framework's own internal logs are correlated and
 * exported too, not just logs the application emits explicitly.
 */
export class TraceLogger implements LoggerService {
  private readonly pinoLogger: PinoLogger;
  private readonly otelLogger: OtelLogger = logs.getLogger('@snokedll/otel-for-nestjs');

  /**
   * @param context prefixed onto every log call unless overridden per-call.
   * @param consoleLevel minimum level written to the console (pino). Does
   * not affect what is emitted via the OpenTelemetry Logs API — every call
   * always emits a `LogRecord`, regardless of this setting. Defaults to
   * `'info'`.
   */
  constructor(
    private readonly context?: string,
    private readonly consoleLevel: LogLevel = 'info',
  ) {
    this.pinoLogger = createPinoLogger(this.consoleLevel);
  }

  private emit(level: LogLevel, message: string, metadata?: LogMetadata, contextOverride?: string, error?: Error): void {
    const context = contextOverride ?? this.context;
    const correlationId = TraceContextManager.getCorrelationId();
    const traceId = TraceContextManager.getTraceId();

    const consoleFields: Record<string, unknown> = {
      ...metadata,
      traceId,
      ...(correlationId ? { correlationId } : {}),
      ...(context ? { context } : {}),
      ...(error ? { err: error } : {}),
    };
    this.pinoLogger[level](consoleFields, message);

    const attributes: LogAttributes = {
      ...metadata,
      'app.trace_id': traceId,
      ...(correlationId ? { [CORRELATION_ID_ATTRIBUTE]: correlationId } : {}),
      ...(context ? { 'app.logger_context': context } : {}),
      ...(error
        ? {
            'exception.type': error.name,
            'exception.message': error.message,
            ...(error.stack ? { 'exception.stacktrace': error.stack } : {}),
          }
        : {}),
    };
    this.otelLogger.emit({ severityNumber: SEVERITY_BY_LEVEL[level], severityText: level.toUpperCase(), body: message, attributes });
  }

  /**
   * Logs at `info` level — the SDK's canonical logging method.
   * @param message the log message.
   * @param optionalParams a {@link LogMetadata} object, a context string, or both.
   */
  info(message: unknown, ...optionalParams: unknown[]): void {
    const { metadata, context } = parseCallArgs(optionalParams);
    this.emit('info', String(message), metadata, context);
  }

  /** Alias of {@link info}, required by Nest's `LoggerService` interface. */
  log(message: unknown, ...optionalParams: unknown[]): void {
    this.info(message, ...optionalParams);
  }

  /** @param message the log message. @param optionalParams a {@link LogMetadata} object, a context string, or both. */
  debug(message: unknown, ...optionalParams: unknown[]): void {
    const { metadata, context } = parseCallArgs(optionalParams);
    this.emit('debug', String(message), metadata, context);
  }

  /** Maps to `debug` — the SDK has no separate `verbose` severity. */
  verbose(message: unknown, ...optionalParams: unknown[]): void {
    const { metadata, context } = parseCallArgs(optionalParams);
    this.emit('debug', String(message), metadata, context);
  }

  /** @param message the log message. @param optionalParams a {@link LogMetadata} object, a context string, or both. */
  warn(message: unknown, ...optionalParams: unknown[]): void {
    const { metadata, context } = parseCallArgs(optionalParams);
    this.emit('warn', String(message), metadata, context);
  }

  /** @param message the log message. @param optionalParams a {@link LogMetadata} object, a context string, or both. */
  fatal(message: unknown, ...optionalParams: unknown[]): void {
    const { metadata, context } = parseCallArgs(optionalParams);
    this.emit('fatal', String(message), metadata, context);
  }

  /**
   * Logs at `error` level. Accepts an `Error` instance, a raw stack trace
   * string (Nest's `error(message, stack, context?)` convention), a
   * {@link LogMetadata} object, and/or a context string, in any
   * combination and order.
   */
  error(message: unknown, ...optionalParams: unknown[]): void {
    const { error, metadata, context } = parseErrorCallArgs(message, optionalParams);
    this.emit('error', String(message), metadata, context, error);
  }
}
