import { describe, it, expect, vi, beforeEach } from 'vitest';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { TELEMETRY_CONFIG } from '../../src/nestjs/telemetry.tokens';
import { HttpTraceInterceptor } from '../../src/interceptors/http-trace.interceptor';

// TelemetryModule.forRoot() now also calls initializeTelemetry() as a side
// effect (single-config-source design, see claude.md) — mocked here so
// this unit test stays a pure check of the DynamicModule shape, without
// spinning up a real NodeSDK (exporters, background timers, ...) on every
// test run.
const initializeTelemetryMock = vi.fn();
vi.mock('../../src/bootstrap/initialize-telemetry', () => ({
  initializeTelemetry: (...args: unknown[]) => initializeTelemetryMock(...args),
}));

const { TelemetryModule } = await import('../../src/nestjs/telemetry.module');

beforeEach(() => {
  initializeTelemetryMock.mockClear();
});

describe('TelemetryModule.forRoot', () => {
  it('returns itself as the module class', () => {
    expect(TelemetryModule.forRoot({ serviceName: 'svc' }).module).toBe(TelemetryModule);
  });

  it('registers HttpTraceInterceptor as a global APP_INTERCEPTOR', () => {
    const dynamicModule = TelemetryModule.forRoot({ serviceName: 'svc' });
    const interceptorProvider = dynamicModule.providers?.find(
      (provider): provider is { provide: unknown; useClass: unknown } =>
        typeof provider === 'object' && provider !== null && 'provide' in provider && provider.provide === APP_INTERCEPTOR,
    );

    expect(interceptorProvider?.useClass).toBe(HttpTraceInterceptor);
  });

  it('provides the resolved config under TELEMETRY_CONFIG', () => {
    const dynamicModule = TelemetryModule.forRoot({ serviceName: 'svc', ignoreRoutes: ['/health'] });
    const configProvider = dynamicModule.providers?.find(
      (provider): provider is { provide: unknown; useValue: { ignoreRoutes: string[] } } =>
        typeof provider === 'object' && provider !== null && 'provide' in provider && provider.provide === TELEMETRY_CONFIG,
    );

    expect(configProvider?.useValue.ignoreRoutes).toEqual(['/health']);
  });

  it('exports TELEMETRY_CONFIG for other modules to inject', () => {
    expect(TelemetryModule.forRoot({ serviceName: 'svc' }).exports).toContain(TELEMETRY_CONFIG);
  });

  it('applies defaults for options not explicitly provided', () => {
    const dynamicModule = TelemetryModule.forRoot({ serviceName: 'svc' });
    const configProvider = dynamicModule.providers?.find(
      (provider): provider is { provide: unknown; useValue: { ignoreRoutes: unknown[] } } =>
        typeof provider === 'object' && provider !== null && 'provide' in provider && provider.provide === TELEMETRY_CONFIG,
    );

    expect(configProvider?.useValue.ignoreRoutes).toEqual([]);
  });

  it('resolves and exposes the environment field alongside the rest of the config', () => {
    const dynamicModule = TelemetryModule.forRoot({ serviceName: 'svc', environment: 'staging' });
    const configProvider = dynamicModule.providers?.find(
      (provider): provider is { provide: unknown; useValue: { environment: unknown } } =>
        typeof provider === 'object' && provider !== null && 'provide' in provider && provider.provide === TELEMETRY_CONFIG,
    );

    expect(configProvider?.useValue.environment).toBe('staging');
  });

  it('initializes the OpenTelemetry SDK as a side effect, with the same raw config', () => {
    const config = { serviceName: 'svc', environment: 'staging' };
    TelemetryModule.forRoot(config);
    expect(initializeTelemetryMock).toHaveBeenCalledWith(config);
  });
});
