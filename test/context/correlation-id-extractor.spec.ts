import { describe, it, expect } from 'vitest';
import { extractCorrelationId, DEFAULT_CORRELATION_ID_SOURCES, CorrelationSource } from '../../src/context/correlation-id-extractor';

describe('DEFAULT_CORRELATION_ID_SOURCES', () => {
  it('checks x-correlation-id, correlation-id, then correlationId headers, in order', () => {
    expect(DEFAULT_CORRELATION_ID_SOURCES).toEqual([
      { from: 'header', key: 'x-correlation-id' },
      { from: 'header', key: 'correlation-id' },
      { from: 'header', key: 'correlationId' },
    ]);
  });
});

describe('extractCorrelationId', () => {
  it('resolves from a lowercase header', () => {
    const value = extractCorrelationId(DEFAULT_CORRELATION_ID_SOURCES, { 'x-correlation-id': 'corr-1' });
    expect(value).toBe('corr-1');
  });

  it('is case-insensitive on the configured header name', () => {
    const value = extractCorrelationId([{ from: 'header', key: 'X-Correlation-Id' }], { 'x-correlation-id': 'corr-2' });
    expect(value).toBe('corr-2');
  });

  it('takes the first value of a multi-valued header', () => {
    const value = extractCorrelationId(DEFAULT_CORRELATION_ID_SOURCES, { 'x-correlation-id': ['first', 'second'] });
    expect(value).toBe('first');
  });

  it('tries sources in order and returns the first non-empty match', () => {
    const value = extractCorrelationId(DEFAULT_CORRELATION_ID_SOURCES, {
      'correlation-id': 'second-source',
      correlationid: 'third-source',
    });
    expect(value).toBe('second-source');
  });

  it('falls through an empty-string header to the next source', () => {
    const value = extractCorrelationId(DEFAULT_CORRELATION_ID_SOURCES, {
      'x-correlation-id': '',
      'correlation-id': 'fallback',
    });
    expect(value).toBe('fallback');
  });

  it('returns undefined when no source matches', () => {
    expect(extractCorrelationId(DEFAULT_CORRELATION_ID_SOURCES, {})).toBeUndefined();
  });

  it('resolves a top-level body field via dot-notation', () => {
    const value = extractCorrelationId([{ from: 'body', key: 'correlationId' }], {}, { correlationId: 'from-body' });
    expect(value).toBe('from-body');
  });

  it('resolves a nested body field via dot-notation', () => {
    const value = extractCorrelationId([{ from: 'body', key: 'metadata.correlationId' }], {}, { metadata: { correlationId: 'nested' } });
    expect(value).toBe('nested');
  });

  it('ignores a non-string body value', () => {
    const value = extractCorrelationId([{ from: 'body', key: 'correlationId' }], {}, { correlationId: 12345 });
    expect(value).toBeUndefined();
  });

  it('does not throw when body is undefined, null, or a primitive', () => {
    const source = [{ from: 'body' as const, key: 'a.b.c' }];
    expect(extractCorrelationId(source, {}, undefined)).toBeUndefined();
    expect(extractCorrelationId(source, {}, null)).toBeUndefined();
    expect(extractCorrelationId(source, {}, 'a string')).toBeUndefined();
    expect(extractCorrelationId(source, {}, 42)).toBeUndefined();
  });

  it('mixes header and body sources in the configured order', () => {
    const sources = [
      { from: 'header' as const, key: 'x-correlation-id' },
      { from: 'body' as const, key: 'correlationId' },
    ];
    expect(extractCorrelationId(sources, {}, { correlationId: 'body-value' })).toBe('body-value');
    expect(extractCorrelationId(sources, { 'x-correlation-id': 'header-value' }, { correlationId: 'body-value' })).toBe('header-value');
  });

  describe('prototype-pollution resistance', () => {
    it('never resolves through __proto__, constructor, or prototype path segments', () => {
      const source = [{ from: 'body' as const, key: '__proto__.polluted' }];
      const body = JSON.parse('{"__proto__": {"polluted": "yes"}}');

      expect(extractCorrelationId(source, {}, body)).toBeUndefined();
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it('rejects a constructor.prototype traversal attempt', () => {
      const source = [{ from: 'body' as const, key: 'constructor.prototype.polluted' }];
      expect(extractCorrelationId(source, {}, {})).toBeUndefined();
    });

    it('only reads own properties, never inherited ones', () => {
      const source = [{ from: 'body' as const, key: 'toString' }];
      expect(extractCorrelationId(source, {}, {})).toBeUndefined();
    });
  });

  describe('source (CorrelationSource) filtering', () => {
    const sources = [
      { from: 'header' as const, key: 'x-correlation-id', source: CorrelationSource.HTTP },
      { from: 'body' as const, key: 'correlationId', source: CorrelationSource.MESSAGE },
    ];

    it('skips a source scoped to a different transport', () => {
      const value = extractCorrelationId(sources, { 'x-correlation-id': 'http-value' }, undefined, CorrelationSource.MESSAGE);
      expect(value).toBeUndefined();
    });

    it('matches a source scoped to the current transport', () => {
      const httpValue = extractCorrelationId(sources, { 'x-correlation-id': 'http-value' }, undefined, CorrelationSource.HTTP);
      expect(httpValue).toBe('http-value');

      const messageValue = extractCorrelationId(sources, {}, { correlationId: 'message-value' }, CorrelationSource.MESSAGE);
      expect(messageValue).toBe('message-value');
    });

    it('tries every source, regardless of scope, when no transport is passed', () => {
      const value = extractCorrelationId(sources, { 'x-correlation-id': 'http-value' }, undefined);
      expect(value).toBe('http-value');
    });

    it('tries an unscoped source (no `source` field) for any transport', () => {
      const value = extractCorrelationId(DEFAULT_CORRELATION_ID_SOURCES, { 'x-correlation-id': 'corr-1' }, undefined, CorrelationSource.MESSAGE);
      expect(value).toBe('corr-1');
    });
  });

  describe('resistance to pathological input', () => {
    it('resolves in bounded time regardless of how deeply nested the body is', () => {
      let deepBody: Record<string, unknown> = { correlationId: 'deep-value' };
      for (let i = 0; i < 50_000; i += 1) {
        deepBody = { next: deepBody };
      }

      const start = performance.now();
      const value = extractCorrelationId([{ from: 'body', key: 'irrelevant.path' }], {}, deepBody);
      const elapsedMs = performance.now() - start;

      expect(value).toBeUndefined();
      expect(elapsedMs).toBeLessThan(50);
    });
  });
});
