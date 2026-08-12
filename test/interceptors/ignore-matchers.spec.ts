import { describe, it, expect } from 'vitest';
import { isRouteIgnored, isEventIgnored } from '../../src/interceptors/ignore-matchers';

describe('isRouteIgnored', () => {
  it('returns false when the ignore list is empty', () => {
    expect(isRouteIgnored('/health', [])).toBe(false);
  });

  it('matches an exact string path', () => {
    expect(isRouteIgnored('/health', ['/health'])).toBe(true);
  });

  it('does not match a different string path', () => {
    expect(isRouteIgnored('/healthy', ['/health'])).toBe(false);
  });

  it('strips the query string before matching', () => {
    expect(isRouteIgnored('/health?probe=1', ['/health'])).toBe(true);
  });

  it('matches via a regular expression pattern', () => {
    expect(isRouteIgnored('/internal/metrics', [/^\/internal\//])).toBe(true);
    expect(isRouteIgnored('/public/metrics', [/^\/internal\//])).toBe(false);
  });

  it('matches if any pattern in the list matches', () => {
    expect(isRouteIgnored('/health', ['/status', '/health'])).toBe(true);
  });

  it('fails closed — never throws and never matches — for a malformed pattern entry', () => {
    // @ts-expect-error deliberately malformed: neither a string nor a RegExp
    expect(() => isRouteIgnored('/health', [{}, null, 42])).not.toThrow();
    // @ts-expect-error see above
    expect(isRouteIgnored('/health', [{}, null, 42])).toBe(false);
  });
});

describe('isEventIgnored', () => {
  it('returns false when no rules are configured', () => {
    expect(isEventIgnored([], { name: 'X' }, {})).toBe(false);
  });

  it('matches a body field exactly', () => {
    const rules = [{ body: { name: 'HEALTH_CHECK' } }];
    expect(isEventIgnored(rules, { name: 'HEALTH_CHECK' }, {})).toBe(true);
    expect(isEventIgnored(rules, { name: 'invoice.created' }, {})).toBe(false);
  });

  it('ignores extra fields not present in the rule', () => {
    const rules = [{ body: { name: 'HEALTH_CHECK' } }];
    expect(isEventIgnored(rules, { name: 'HEALTH_CHECK', amount: 100 }, {})).toBe(true);
  });

  it('matches nested body fields', () => {
    const rules = [{ body: { metadata: { kind: 'probe' } } }];
    expect(isEventIgnored(rules, { metadata: { kind: 'probe', extra: true } }, {})).toBe(true);
    expect(isEventIgnored(rules, { metadata: { kind: 'other' } }, {})).toBe(false);
  });

  it('matches header criteria', () => {
    const rules = [{ headers: { 'x-probe': 'true' } }];
    expect(isEventIgnored(rules, {}, { 'x-probe': 'true' })).toBe(true);
    expect(isEventIgnored(rules, {}, {})).toBe(false);
  });

  it('requires both body and headers criteria to match when both are specified', () => {
    const rules = [{ body: { name: 'X' }, headers: { 'x-probe': 'true' } }];
    expect(isEventIgnored(rules, { name: 'X' }, {})).toBe(false);
    expect(isEventIgnored(rules, { name: 'X' }, { 'x-probe': 'true' })).toBe(true);
  });

  it('does not match a rule with neither body nor headers criteria', () => {
    expect(isEventIgnored([{}], { name: 'anything' }, {})).toBe(false);
  });

  it('matches if any rule in the list matches', () => {
    const rules = [{ body: { name: 'A' } }, { body: { name: 'B' } }];
    expect(isEventIgnored(rules, { name: 'B' }, {})).toBe(true);
  });

  it('does not match when the actual body is not an object', () => {
    expect(isEventIgnored([{ body: { name: 'X' } }], 'a string', {})).toBe(false);
    expect(isEventIgnored([{ body: { name: 'X' } }], null, {})).toBe(false);
    expect(isEventIgnored([{ body: { name: 'X' } }], undefined, {})).toBe(false);
  });

  describe('resistance to pathological input', () => {
    it('matches in bounded time regardless of how deeply nested the actual body is', () => {
      let deepBody: Record<string, unknown> = { name: 'X' };
      for (let i = 0; i < 50_000; i += 1) {
        deepBody = { next: deepBody };
      }

      const start = performance.now();
      const matched = isEventIgnored([{ body: { name: 'X' } }], deepBody, {});
      const elapsedMs = performance.now() - start;

      expect(matched).toBe(false);
      expect(elapsedMs).toBeLessThan(50);
    });
  });
});
