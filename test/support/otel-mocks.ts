import { vi } from 'vitest';
import type { Span, SpanContext, Tracer } from '@opentelemetry/api';

export interface FakeSpan extends Span {
  name: string;
  ended: boolean;
  attributes: Record<string, unknown>;
  status?: { code: number; message?: string };
  exceptions: unknown[];
}

export function createFakeSpan(name: string): FakeSpan {
  const span: Partial<FakeSpan> = {
    name,
    ended: false,
    attributes: {},
    exceptions: [],
    setAttribute: vi.fn((key: string, value: unknown) => {
      span.attributes![key] = value;
      return span as Span;
    }),
    setAttributes: vi.fn((attrs: Record<string, unknown>) => {
      Object.assign(span.attributes!, attrs);
      return span as Span;
    }),
    setStatus: vi.fn((status) => {
      span.status = status;
      return span as Span;
    }),
    recordException: vi.fn((exception) => {
      span.exceptions!.push(exception);
    }),
    end: vi.fn(() => {
      span.ended = true;
    }),
    spanContext: vi.fn(
      () =>
        ({
          traceId: '0'.repeat(32),
          spanId: '0'.repeat(16),
          traceFlags: 1,
        }) as SpanContext,
    ),
    isRecording: vi.fn(() => true),
    addEvent: vi.fn(() => span as Span),
    updateName: vi.fn(() => span as Span),
    addLink: vi.fn(() => span as Span),
    addLinks: vi.fn(() => span as Span),
  };
  return span as FakeSpan;
}

export interface FakeTracer extends Tracer {
  spans: FakeSpan[];
}

export function createFakeTracer(): FakeTracer {
  const spans: FakeSpan[] = [];
  return {
    spans,
    startSpan: vi.fn((name: string) => {
      const span = createFakeSpan(name);
      spans.push(span);
      return span;
    }),
    startActiveSpan: vi.fn((name: string, ...rest: unknown[]) => {
      const span = createFakeSpan(name);
      spans.push(span);
      const callback = rest[rest.length - 1] as (span: FakeSpan) => unknown;
      return callback(span);
    }),
  } as unknown as FakeTracer;
}

export function createFakeInstrument() {
  return {
    add: vi.fn(),
    record: vi.fn(),
    addCallback: vi.fn(),
    removeCallback: vi.fn(),
  };
}

export function createFakeMeter() {
  const created: Record<string, unknown> = {};
  const factory = (kind: string) =>
    vi.fn((name: string) => {
      const instrument = createFakeInstrument();
      created[`${kind}:${name}`] = instrument;
      return instrument;
    });

  return {
    created,
    createCounter: factory('counter'),
    createHistogram: factory('histogram'),
    createUpDownCounter: factory('upDownCounter'),
    createObservableGauge: factory('observableGauge'),
    createObservableCounter: factory('observableCounter'),
    createObservableUpDownCounter: factory('observableUpDownCounter'),
    createGauge: factory('gauge'),
    addBatchObservableCallback: vi.fn(),
    removeBatchObservableCallback: vi.fn(),
  };
}

export function createFakeOtelLogger() {
  return { emit: vi.fn() };
}
