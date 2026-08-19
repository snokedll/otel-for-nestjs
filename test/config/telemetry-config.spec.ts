import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveTelemetryConfig } from '../../src/config/telemetry-config';
import { DEFAULT_CORRELATION_ID_SOURCES } from '../../src/context/correlation-id-extractor';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveTelemetryConfig', () => {
  it('enables every signal by default', () => {
    const resolved = resolveTelemetryConfig({ serviceName: 'svc' });
    expect(resolved.logs.enabled).toBe(true);
    expect(resolved.traces.enabled).toBe(true);
    expect(resolved.metrics.enabled).toBe(true);
  });

  it('defaults to the http/protobuf protocol', () => {
    expect(resolveTelemetryConfig({ serviceName: 'svc' }).protocol).toBe('http/protobuf');
  });

  it('respects an explicit protocol', () => {
    expect(resolveTelemetryConfig({ serviceName: 'svc', protocol: 'http/json' }).protocol).toBe('http/json');
  });

  it('preserves the service name verbatim', () => {
    expect(resolveTelemetryConfig({ serviceName: 'billing-service' }).serviceName).toBe('billing-service');
  });

  it('disables a signal explicitly, with no endpoint resolved for it', () => {
    const resolved = resolveTelemetryConfig({ serviceName: 'svc', metrics: { enabled: false } });
    expect(resolved.metrics.enabled).toBe(false);
    expect(resolved.metrics.endpoint).toBeUndefined();
  });

  it('falls back to the shared endpoint, appending the signal-specific OTLP path', () => {
    const resolved = resolveTelemetryConfig({ serviceName: 'svc', endpoint: 'http://collector:4318' });
    expect(resolved.traces.endpoint).toBe('http://collector:4318/v1/traces');
    expect(resolved.logs.endpoint).toBe('http://collector:4318/v1/logs');
    expect(resolved.metrics.endpoint).toBe('http://collector:4318/v1/metrics');
  });

  it('strips a trailing slash from the shared endpoint before appending the OTLP path', () => {
    const resolved = resolveTelemetryConfig({ serviceName: 'svc', endpoint: 'http://collector:4318/' });
    expect(resolved.traces.endpoint).toBe('http://collector:4318/v1/traces');
  });

  it('prefers a signal-specific endpoint over the shared one', () => {
    const resolved = resolveTelemetryConfig({
      serviceName: 'svc',
      endpoint: 'http://shared:4318',
      traces: { endpoint: 'http://traces-only:4318' },
    });
    expect(resolved.traces.endpoint).toBe('http://traces-only:4318/v1/traces');
    expect(resolved.logs.endpoint).toBe('http://shared:4318/v1/logs');
  });

  it('does not double-append the OTLP path when the endpoint already ends with it', () => {
    const resolved = resolveTelemetryConfig({ serviceName: 'svc', traces: { endpoint: 'http://collector:4318/v1/traces' } });
    expect(resolved.traces.endpoint).toBe('http://collector:4318/v1/traces');
  });

  it('trusts a custom base path completely instead of appending the signal path onto it', () => {
    const resolved = resolveTelemetryConfig({ serviceName: 'svc', traces: { endpoint: 'http://collector:4318/otlp' } });
    expect(resolved.traces.endpoint).toBe('http://collector:4318/otlp');
  });

  it('trusts any custom path as given, trailing slash included', () => {
    const resolved = resolveTelemetryConfig({ serviceName: 'svc', metrics: { endpoint: 'http://collector:4318/custom/route/' } });
    expect(resolved.metrics.endpoint).toBe('http://collector:4318/custom/route/');
  });

  it('leaves temporalityPreference undefined by default', () => {
    const resolved = resolveTelemetryConfig({ serviceName: 'svc' });
    expect(resolved.metrics.temporalityPreference).toBeUndefined();
  });

  it('preserves an explicit temporalityPreference', () => {
    const resolved = resolveTelemetryConfig({ serviceName: 'svc', metrics: { temporalityPreference: 'delta' } });
    expect(resolved.metrics.temporalityPreference).toBe('delta');
  });

  it('leaves the endpoint undefined when neither a specific nor a shared endpoint is configured', () => {
    const resolved = resolveTelemetryConfig({ serviceName: 'svc' });
    expect(resolved.traces.endpoint).toBeUndefined();
  });

  it('warns exactly once per enabled signal missing an endpoint', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resolveTelemetryConfig({ serviceName: 'svc' });
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('does not warn for a disabled signal missing an endpoint', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resolveTelemetryConfig({ serviceName: 'svc', metrics: { enabled: false } });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('does not warn when every enabled signal has a resolved endpoint', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resolveTelemetryConfig({ serviceName: 'svc', endpoint: 'http://collector:4318' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('leaves environment undefined when not configured', () => {
    expect(resolveTelemetryConfig({ serviceName: 'svc' }).environment).toBeUndefined();
  });

  it('preserves an explicit environment verbatim', () => {
    expect(resolveTelemetryConfig({ serviceName: 'svc', environment: 'staging' }).environment).toBe('staging');
  });

  it('defaults correlationIdSources to DEFAULT_CORRELATION_ID_SOURCES', () => {
    expect(resolveTelemetryConfig({ serviceName: 'svc' }).correlationIdSources).toBe(DEFAULT_CORRELATION_ID_SOURCES);
  });

  it('defaults ignoreRoutes and ignoreEvents to empty arrays', () => {
    const resolved = resolveTelemetryConfig({ serviceName: 'svc' });
    expect(resolved.ignoreRoutes).toEqual([]);
    expect(resolved.ignoreEvents).toEqual([]);
  });

  it('preserves explicit correlationIdSources', () => {
    const sources = [{ from: 'body' as const, key: 'x' }];
    expect(resolveTelemetryConfig({ serviceName: 'svc', correlationIdSources: sources }).correlationIdSources).toBe(sources);
  });

  it('preserves explicit ignoreRoutes and ignoreEvents', () => {
    const resolved = resolveTelemetryConfig({
      serviceName: 'svc',
      ignoreRoutes: ['/health'],
      ignoreEvents: [{ body: { name: 'X' } }],
    });
    expect(resolved.ignoreRoutes).toEqual(['/health']);
    expect(resolved.ignoreEvents).toEqual([{ body: { name: 'X' } }]);
  });
});
