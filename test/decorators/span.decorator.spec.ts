import 'reflect-metadata';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { Span, type SpanOptions } from '../../src/decorators/span.decorator';
import { CORRELATION_ID_ATTRIBUTE, TraceContextManager } from '../../src/context/trace-context';
import { createFakeTracer } from '../support/otel-mocks';

function mockTracer() {
  const tracer = createFakeTracer();
  vi.spyOn(trace, 'getTracer').mockReturnValue(tracer);
  return tracer;
}

afterEach(() => {
  vi.restoreAllMocks();
});

class Sample {
  syncOk(value: number): number {
    return value * 2;
  }

  syncThrow(): never {
    throw new Error('sync failure');
  }

  async asyncOk(value: string): Promise<string> {
    return `${value}!`;
  }

  async asyncThrow(): Promise<never> {
    throw new Error('async failure');
  }
}

function applySpan(methodName: keyof Sample, options?: SpanOptions | string) {
  const original = Object.getOwnPropertyDescriptor(Sample.prototype, methodName)!;
  const decorated = Span(options)(Sample.prototype, methodName, { ...original });
  return decorated.value as (...args: unknown[]) => unknown;
}

describe('@Span', () => {
  it('names the span ClassName.methodName by default', () => {
    const tracer = mockTracer();
    applySpan('syncOk')(1);
    expect(tracer.startActiveSpan).toHaveBeenCalledWith('Sample.syncOk', expect.any(Function));
  });

  it('accepts a custom name as a plain string', () => {
    const tracer = mockTracer();
    applySpan('syncOk', 'custom-name')(1);
    expect(tracer.startActiveSpan).toHaveBeenCalledWith('custom-name', expect.any(Function));
  });

  it('sets custom attributes on the span', () => {
    const tracer = mockTracer();
    applySpan('syncOk', { attributes: { 'app.kind': 'test' } })(1);
    expect(tracer.spans[0].attributes).toEqual({ 'app.kind': 'test' });
  });

  it('tags the span with app.correlation_id when a correlation id is active', () => {
    const tracer = mockTracer();
    const context = TraceContextManager.createContext({ correlationId: 'corr-span' });

    TraceContextManager.run(context, () => applySpan('syncOk')(1));

    expect(tracer.spans[0].attributes).toEqual(expect.objectContaining({ [CORRELATION_ID_ATTRIBUTE]: 'corr-span' }));
  });

  it('does not set app.correlation_id when no correlation id is active', () => {
    const tracer = mockTracer();
    applySpan('syncOk')(1);
    expect(tracer.spans[0].attributes).not.toHaveProperty(CORRELATION_ID_ATTRIBUTE);
  });

  it('returns the original synchronous return value and ends the span OK', () => {
    const tracer = mockTracer();
    const result = applySpan('syncOk')(21);

    expect(result).toBe(42);
    expect(tracer.spans[0].ended).toBe(true);
    expect(tracer.spans[0].status).toEqual({ code: SpanStatusCode.OK });
  });

  it('records the exception and rethrows for a synchronous throw', () => {
    const tracer = mockTracer();
    const wrapped = applySpan('syncThrow');

    expect(() => wrapped()).toThrow('sync failure');
    expect(tracer.spans[0].ended).toBe(true);
    expect(tracer.spans[0].status?.code).toBe(SpanStatusCode.ERROR);
    expect(tracer.spans[0].exceptions).toHaveLength(1);
  });

  it('resolves the original value and ends the span OK for an async method', async () => {
    const tracer = mockTracer();
    await expect(applySpan('asyncOk')('hi')).resolves.toBe('hi!');
    expect(tracer.spans[0].ended).toBe(true);
    expect(tracer.spans[0].status).toEqual({ code: SpanStatusCode.OK });
  });

  it('records the exception and rejects for an async method', async () => {
    const tracer = mockTracer();
    await expect(applySpan('asyncThrow')()).rejects.toThrow('async failure');
    expect(tracer.spans[0].ended).toBe(true);
    expect(tracer.spans[0].status?.code).toBe(SpanStatusCode.ERROR);
  });

  it('rejects a symbol-keyed property', () => {
    expect(() => Span()(Sample.prototype, Symbol('sym'), { value: () => {} })).toThrow(/string name/);
  });

  it('preserves Function.prototype.name on the wrapper (Nest ExecutionContext.getHandler().name reads it)', () => {
    mockTracer();
    const wrapped = applySpan('syncOk');
    expect(wrapped.name).toBe('syncOk');
  });

  describe('decoration-order independence', () => {
    it('preserves metadata already attached before @Span runs (Nest route decorator declared above @Span)', () => {
      const original = Object.getOwnPropertyDescriptor(Sample.prototype, 'syncOk')!;
      Reflect.defineMetadata('path', '/invoices/:id', original.value);

      const wrapped = Span()(Sample.prototype, 'syncOk', { ...original }).value as (...args: unknown[]) => unknown;

      expect(Reflect.getMetadata('path', wrapped)).toBe('/invoices/:id');
    });
  });
});
