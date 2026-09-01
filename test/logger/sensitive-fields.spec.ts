import { describe, it, expect, afterEach } from 'vitest';
import {
  redactSensitiveFields,
  RECOMMENDED_SENSITIVE_FIELDS,
  DEFAULT_REDACTION_PLACEHOLDER,
  setActiveRedactionConfig,
  getActiveRedactionConfig,
  resetActiveRedactionConfig,
} from '../../src/logger/sensitive-fields';

afterEach(() => {
  resetActiveRedactionConfig();
});

describe('redactSensitiveFields', () => {
  it('returns the value unchanged when there are no patterns to redact', () => {
    const value = { a: 1 };
    expect(redactSensitiveFields(value, [])).toBe(value);
  });

  it('redacts a top-level field matching a bare pattern', () => {
    expect(redactSensitiveFields({ password: 'hunter2', userId: 1 }, ['password'])).toEqual({
      password: '[REDACTED]',
      userId: 1,
    });
  });

  it('matches a bare pattern case-insensitively', () => {
    expect(redactSensitiveFields({ Authorization: 'Bearer x' }, ['authorization'])).toEqual({ Authorization: '[REDACTED]' });
  });

  it('redacts a bare pattern at any nesting depth, regardless of the object shape', () => {
    const kafkaShaped = { headers: { authorization: 'Bearer x' } };
    const httpShaped = { request: { headers: { authorization: 'Bearer y' } } };
    expect(redactSensitiveFields(kafkaShaped, ['authorization'])).toEqual({ headers: { authorization: '[REDACTED]' } });
    expect(redactSensitiveFields(httpShaped, ['authorization'])).toEqual({ request: { headers: { authorization: '[REDACTED]' } } });
  });

  it('redacts a bare pattern inside every element of an array', () => {
    const value = { items: [{ cardNumber: '4111' }, { cardNumber: '5500' }] };
    expect(redactSensitiveFields(value, ['cardNumber'])).toEqual({
      items: [{ cardNumber: '[REDACTED]' }, { cardNumber: '[REDACTED]' }],
    });
  });

  it('matches a dot-notation pattern only at the exact path, leaving the same key elsewhere untouched', () => {
    const value = { body: { card: { number: '4111' } }, other: { number: '42' } };
    expect(redactSensitiveFields(value, ['body.card.number'])).toEqual({
      body: { card: { number: '[REDACTED]' } },
      other: { number: '42' },
    });
  });

  it('never mutates the original value', () => {
    const original = { password: 'hunter2' };
    const redacted = redactSensitiveFields(original, ['password']);
    expect(original.password).toBe('hunter2');
    expect(redacted).not.toBe(original);
  });

  it('skips prototype-pollution-prone keys instead of walking into them', () => {
    // JSON.parse (unlike an object literal) produces a real OWN property
    // named "__proto__" — exactly the shape an attacker-controlled
    // request/event body could arrive in.
    const malicious = JSON.parse('{"__proto__": {"polluted": true}, "safe": 1}') as Record<string, unknown>;
    const result = redactSensitiveFields(malicious, ['polluted']) as Record<string, unknown>;

    expect(result.safe).toBe(1);
    expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(false);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });

  it('leaves primitives, null, and non-matching structures untouched', () => {
    expect(redactSensitiveFields('hello', ['password'])).toBe('hello');
    expect(redactSensitiveFields(42, ['password'])).toBe(42);
    expect(redactSensitiveFields(null, ['password'])).toBeNull();
    expect(redactSensitiveFields({ a: { b: 1 } }, ['password'])).toEqual({ a: { b: 1 } });
  });

  it('defaults the placeholder to DEFAULT_REDACTION_PLACEHOLDER when not given', () => {
    expect(redactSensitiveFields({ password: 'hunter2' }, ['password'])).toEqual({ password: DEFAULT_REDACTION_PLACEHOLDER });
  });

  it('replaces a redacted field with a custom placeholder when given one', () => {
    expect(redactSensitiveFields({ password: 'hunter2' }, ['password'], '***')).toEqual({ password: '***' });
  });

  it('applies the custom placeholder at every redacted location, nested or not', () => {
    const value = { headers: { authorization: 'Bearer x' }, body: { password: 'hunter2' } };
    expect(redactSensitiveFields(value, ['authorization', 'password'], '<oculto>')).toEqual({
      headers: { authorization: '<oculto>' },
      body: { password: '<oculto>' },
    });
  });
});

describe('RECOMMENDED_SENSITIVE_FIELDS', () => {
  it('is not applied automatically — redactSensitiveFields still requires it to be passed explicitly', () => {
    const value = { authorization: 'Bearer x' };
    expect(redactSensitiveFields(value, [])).toBe(value);
  });

  it('redacts common credential-carrying fields when spread into an explicit pattern list', () => {
    const value = { authorization: 'Bearer x', cookie: 'a=b', password: 'p', token: 't', apikey: 'k' };
    expect(redactSensitiveFields(value, RECOMMENDED_SENSITIVE_FIELDS)).toEqual({
      authorization: '[REDACTED]',
      cookie: '[REDACTED]',
      password: '[REDACTED]',
      token: '[REDACTED]',
      apikey: '[REDACTED]',
    });
  });
});

describe('active redaction config registry', () => {
  it('defaults to an empty pattern list and the default placeholder before anything sets it', () => {
    expect(getActiveRedactionConfig()).toEqual({ patterns: [], placeholder: DEFAULT_REDACTION_PLACEHOLDER });
  });

  it('reflects whatever setActiveRedactionConfig() last set', () => {
    setActiveRedactionConfig({ patterns: ['cpf'], placeholder: '***' });
    expect(getActiveRedactionConfig()).toEqual({ patterns: ['cpf'], placeholder: '***' });
  });

  it('resetActiveRedactionConfig() restores the empty list and the default placeholder', () => {
    setActiveRedactionConfig({ patterns: ['cpf'], placeholder: '***' });
    resetActiveRedactionConfig();
    expect(getActiveRedactionConfig()).toEqual({ patterns: [], placeholder: DEFAULT_REDACTION_PLACEHOLDER });
  });
});
