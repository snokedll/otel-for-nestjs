import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('pino', () => {
  const factory = vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  }));
  Object.assign(factory, { stdSerializers: { err: vi.fn((e: unknown) => e) } });
  return { default: factory };
});

const otelLoggerEmit = vi.fn();
vi.mock('@opentelemetry/api-logs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opentelemetry/api-logs')>();
  return {
    ...actual,
    logs: { ...actual.logs, getLogger: vi.fn(() => ({ emit: otelLoggerEmit })) },
  };
});

const pinoModule = await import('pino');
const { TraceLogger } = await import('../../src/logger/trace-logger');
const { TraceContextManager } = await import('../../src/context/trace-context');

function lastPinoInstance() {
  const factory = vi.mocked(pinoModule.default);
  return factory.mock.results[factory.mock.results.length - 1].value as Record<string, ReturnType<typeof vi.fn>>;
}

beforeEach(() => {
  otelLoggerEmit.mockClear();
  vi.spyOn(TraceContextManager, 'getTraceId').mockReturnValue('trace-abc');
  vi.spyOn(TraceContextManager, 'getCorrelationId').mockReturnValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TraceLogger', () => {
  describe('info / log', () => {
    it('writes to pino at info level with the trace id attached', () => {
      new TraceLogger('MyService').info('hello');
      const pino = lastPinoInstance();
      expect(pino.info).toHaveBeenCalledWith(expect.objectContaining({ traceId: 'trace-abc', context: 'MyService' }), 'hello');
    });

    it('merges an object argument as metadata', () => {
      new TraceLogger().info('hello', { userId: 42 });
      const pino = lastPinoInstance();
      expect(pino.info).toHaveBeenCalledWith(expect.objectContaining({ userId: 42 }), 'hello');
    });

    it('treats a trailing string argument as a context override, Nest-style', () => {
      new TraceLogger('DefaultCtx').info('hello', 'OverrideCtx');
      const pino = lastPinoInstance();
      expect(pino.info).toHaveBeenCalledWith(expect.objectContaining({ context: 'OverrideCtx' }), 'hello');
    });

    it('accepts metadata and a context override together, in either order', () => {
      new TraceLogger().info('hello', { a: 1 }, 'Ctx');
      const pino = lastPinoInstance();
      expect(pino.info).toHaveBeenCalledWith(expect.objectContaining({ a: 1, context: 'Ctx' }), 'hello');
    });

    it('log() is an alias for info()', () => {
      new TraceLogger().log('hello');
      expect(lastPinoInstance().info).toHaveBeenCalled();
    });

    it('emits a matching OTel LogRecord', () => {
      new TraceLogger('Ctx').info('hello', { a: 1 });
      expect(otelLoggerEmit).toHaveBeenCalledWith(
        expect.objectContaining({
          severityText: 'INFO',
          body: 'hello',
          attributes: expect.objectContaining({ a: 1, 'app.trace_id': 'trace-abc', 'app.logger_context': 'Ctx' }),
        }),
      );
    });

    it('includes the correlation id when one is active', () => {
      vi.spyOn(TraceContextManager, 'getCorrelationId').mockReturnValue('corr-1');
      new TraceLogger().info('hello');
      expect(lastPinoInstance().info).toHaveBeenCalledWith(expect.objectContaining({ correlationId: 'corr-1' }), 'hello');
      expect(otelLoggerEmit).toHaveBeenCalledWith(expect.objectContaining({ attributes: expect.objectContaining({ 'app.correlation_id': 'corr-1' }) }));
    });

    it('coerces a non-string message via String()', () => {
      new TraceLogger().info(42);
      expect(lastPinoInstance().info).toHaveBeenCalledWith(expect.anything(), '42');
    });
  });

  describe('debug / verbose', () => {
    it('debug() writes at debug level', () => {
      new TraceLogger().debug('d');
      expect(lastPinoInstance().debug).toHaveBeenCalled();
    });

    it('verbose() maps to debug level', () => {
      new TraceLogger().verbose('v');
      expect(lastPinoInstance().debug).toHaveBeenCalledWith(expect.anything(), 'v');
    });
  });

  describe('warn', () => {
    it('writes at warn level', () => {
      new TraceLogger().warn('w');
      expect(lastPinoInstance().warn).toHaveBeenCalled();
    });
  });

  describe('fatal', () => {
    it('writes at fatal level with FATAL severity', () => {
      new TraceLogger().fatal('f');
      expect(lastPinoInstance().fatal).toHaveBeenCalled();
      expect(otelLoggerEmit).toHaveBeenCalledWith(expect.objectContaining({ severityText: 'FATAL' }));
    });
  });

  describe('error', () => {
    it('accepts a plain message with no error', () => {
      new TraceLogger().error('oops');
      expect(lastPinoInstance().error).toHaveBeenCalledWith(expect.not.objectContaining({ err: expect.anything() }), 'oops');
    });

    it('accepts an Error instance (SDK convention)', () => {
      const err = new Error('boom');
      new TraceLogger().error('oops', err);
      expect(lastPinoInstance().error).toHaveBeenCalledWith(expect.objectContaining({ err }), 'oops');
      expect(otelLoggerEmit).toHaveBeenCalledWith(
        expect.objectContaining({ attributes: expect.objectContaining({ 'exception.type': 'Error', 'exception.message': 'boom' }) }),
      );
    });

    it('accepts an Error plus metadata', () => {
      const err = new Error('boom');
      new TraceLogger().error('oops', err, { orderId: 7 });
      expect(lastPinoInstance().error).toHaveBeenCalledWith(expect.objectContaining({ err, orderId: 7 }), 'oops');
    });

    it('treats a raw multi-line stack trace as an error (Nest convention: error(message, stack, context?))', () => {
      const stack = 'Some error\n    at Object.<anonymous> (/app/index.js:10:5)';
      new TraceLogger().error('failed', stack, 'RoutesResolver');
      const call = lastPinoInstance().error.mock.calls[0][0] as { err?: Error; context?: string };
      expect(call.err).toBeInstanceOf(Error);
      expect(call.err?.stack).toBe(stack);
      expect(call.context).toBe('RoutesResolver');
    });

    it('treats a plain string without stack shape as a context override', () => {
      new TraceLogger().error('failed', 'SomeContext');
      const call = lastPinoInstance().error.mock.calls[0][0] as { err?: Error; context?: string };
      expect(call.err).toBeUndefined();
      expect(call.context).toBe('SomeContext');
    });
  });
});
