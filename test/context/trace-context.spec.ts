import { describe, it, expect, vi, afterEach } from 'vitest';
import { trace } from '@opentelemetry/api';
import { TraceContextManager, CORRELATION_ID_ATTRIBUTE } from '../../src/context/trace-context';
import { createFakeSpan } from '../support/otel-mocks';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TraceContextManager', () => {
  describe('generateTraceId / generateSpanId', () => {
    it('generates a 32-hex-char trace id', () => {
      expect(TraceContextManager.generateTraceId()).toMatch(/^[0-9a-f]{32}$/);
    });

    it('generates a 16-hex-char span id', () => {
      expect(TraceContextManager.generateSpanId()).toMatch(/^[0-9a-f]{16}$/);
    });

    it('generates distinct ids on each call', () => {
      const a = TraceContextManager.generateTraceId();
      const b = TraceContextManager.generateTraceId();
      expect(a).not.toBe(b);
    });
  });

  describe('getActiveOtelTraceId / getActiveOtelSpanId', () => {
    it('returns undefined when there is no active span', () => {
      vi.spyOn(trace, 'getActiveSpan').mockReturnValue(undefined);
      expect(TraceContextManager.getActiveOtelTraceId()).toBeUndefined();
      expect(TraceContextManager.getActiveOtelSpanId()).toBeUndefined();
    });

    it('returns undefined for a no-op span (zeroed, invalid span context)', () => {
      const span = createFakeSpan('noop');
      vi.spyOn(span, 'spanContext').mockReturnValue({ traceId: '0'.repeat(32), spanId: '0'.repeat(16), traceFlags: 0 });
      vi.spyOn(trace, 'getActiveSpan').mockReturnValue(span);
      expect(TraceContextManager.getActiveOtelTraceId()).toBeUndefined();
      expect(TraceContextManager.getActiveOtelSpanId()).toBeUndefined();
    });

    it('returns the real ids for a valid active span', () => {
      const span = createFakeSpan('real');
      vi.spyOn(span, 'spanContext').mockReturnValue({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 });
      vi.spyOn(trace, 'getActiveSpan').mockReturnValue(span);
      expect(TraceContextManager.getActiveOtelTraceId()).toBe('a'.repeat(32));
      expect(TraceContextManager.getActiveOtelSpanId()).toBe('b'.repeat(16));
    });
  });

  describe('createContext', () => {
    it('generates a synthetic trace id when there is no active span and no override', () => {
      vi.spyOn(trace, 'getActiveSpan').mockReturnValue(undefined);
      const context = TraceContextManager.createContext();
      expect(context.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(context.spanId).toBeUndefined();
      expect(context.correlationId).toBeUndefined();
      expect(context.timestamp).toBeGreaterThan(0);
    });

    it('prefers the active span id over a generated one', () => {
      const span = createFakeSpan('real');
      vi.spyOn(span, 'spanContext').mockReturnValue({ traceId: 'c'.repeat(32), spanId: 'd'.repeat(16), traceFlags: 1 });
      vi.spyOn(trace, 'getActiveSpan').mockReturnValue(span);
      const context = TraceContextManager.createContext();
      expect(context.traceId).toBe('c'.repeat(32));
      expect(context.spanId).toBe('d'.repeat(16));
    });

    it('lets explicit overrides win over the active span', () => {
      const span = createFakeSpan('real');
      vi.spyOn(span, 'spanContext').mockReturnValue({ traceId: 'c'.repeat(32), spanId: 'd'.repeat(16), traceFlags: 1 });
      vi.spyOn(trace, 'getActiveSpan').mockReturnValue(span);
      const context = TraceContextManager.createContext({ traceId: 'override'.padEnd(32, '0'), correlationId: 'corr-1' });
      expect(context.traceId).toBe('override'.padEnd(32, '0'));
      expect(context.correlationId).toBe('corr-1');
    });

    it('tags the active span with app.correlation_id when a correlation id is provided', () => {
      const span = createFakeSpan('real');
      vi.spyOn(trace, 'getActiveSpan').mockReturnValue(span);
      TraceContextManager.createContext({ correlationId: 'corr-tagged' });
      expect(span.setAttribute).toHaveBeenCalledWith(CORRELATION_ID_ATTRIBUTE, 'corr-tagged');
    });

    it('does not touch the active span when no correlation id is provided', () => {
      const span = createFakeSpan('real');
      vi.spyOn(trace, 'getActiveSpan').mockReturnValue(span);
      TraceContextManager.createContext();
      expect(span.setAttribute).not.toHaveBeenCalled();
    });

    it('does not throw when there is no active span to tag', () => {
      vi.spyOn(trace, 'getActiveSpan').mockReturnValue(undefined);
      expect(() => TraceContextManager.createContext({ correlationId: 'corr-2' })).not.toThrow();
    });
  });

  describe('run / getContext / getTraceId / getSpanId / getCorrelationId', () => {
    it('exposes the context only within run()', () => {
      vi.spyOn(trace, 'getActiveSpan').mockReturnValue(undefined);
      expect(TraceContextManager.getContext()).toBeUndefined();

      const context = TraceContextManager.createContext({ correlationId: 'abc' });
      const observed = TraceContextManager.run(context, () => TraceContextManager.getContext());

      expect(observed).toEqual(context);
      expect(TraceContextManager.getContext()).toBeUndefined();
    });

    it('isolates nested run() calls from each other', () => {
      const outer = TraceContextManager.createContext({ correlationId: 'outer' });
      const inner = TraceContextManager.createContext({ correlationId: 'inner' });

      TraceContextManager.run(outer, () => {
        expect(TraceContextManager.getCorrelationId()).toBe('outer');
        TraceContextManager.run(inner, () => {
          expect(TraceContextManager.getCorrelationId()).toBe('inner');
        });
        expect(TraceContextManager.getCorrelationId()).toBe('outer');
      });
    });

    it('propagates context across async continuations within run()', async () => {
      const context = TraceContextManager.createContext({ correlationId: 'async-corr' });

      await TraceContextManager.run(context, async () => {
        await Promise.resolve();
        await new Promise((resolve) => setImmediate(resolve));
        expect(TraceContextManager.getCorrelationId()).toBe('async-corr');
      });
    });

    it('getTraceId falls back to the active span, then to the literal sentinel', () => {
      vi.spyOn(trace, 'getActiveSpan').mockReturnValue(undefined);
      expect(TraceContextManager.getTraceId()).toBe('no-trace-context');

      const span = createFakeSpan('real');
      vi.spyOn(span, 'spanContext').mockReturnValue({ traceId: 'e'.repeat(32), spanId: 'f'.repeat(16), traceFlags: 1 });
      vi.spyOn(trace, 'getActiveSpan').mockReturnValue(span);
      expect(TraceContextManager.getTraceId()).toBe('e'.repeat(32));
    });
  });

  describe('setCorrelationId', () => {
    it('creates a context when none exists yet', () => {
      vi.spyOn(trace, 'getActiveSpan').mockReturnValue(undefined);
      TraceContextManager.run(TraceContextManager.createContext(), () => {
        TraceContextManager.setCorrelationId('late-corr');
        expect(TraceContextManager.getCorrelationId()).toBe('late-corr');
      });
    });

    it('mutates the current context in place', () => {
      const context = TraceContextManager.createContext({ correlationId: 'first' });
      TraceContextManager.run(context, () => {
        TraceContextManager.setCorrelationId('second');
        expect(TraceContextManager.getContext()?.correlationId).toBe('second');
      });
    });
  });
});
