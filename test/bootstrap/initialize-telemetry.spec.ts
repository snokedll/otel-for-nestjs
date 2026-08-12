import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ATTR_DEPLOYMENT_ENVIRONMENT_NAME } from '@opentelemetry/semantic-conventions';

const nodeSdkInstances: Array<{ config: unknown; start: ReturnType<typeof vi.fn>; shutdown: ReturnType<typeof vi.fn> }> = [];

vi.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: vi.fn().mockImplementation(function (this: unknown, config: unknown) {
    const instance = { config, start: vi.fn(), shutdown: vi.fn().mockResolvedValue(undefined) };
    nodeSdkInstances.push(instance);
    Object.assign(this as object, instance);
  }),
}));

vi.mock('@opentelemetry/auto-instrumentations-node', () => ({
  getNodeAutoInstrumentations: vi.fn().mockReturnValue([]),
}));

const { initializeTelemetry, shutdownTelemetry } = await import('../../src/bootstrap/initialize-telemetry');

function lastSdkConfig() {
  return nodeSdkInstances[nodeSdkInstances.length - 1].config as {
    serviceName: string;
    resource?: { attributes: Record<string, unknown> };
    spanProcessors: unknown[];
    logRecordProcessors: unknown[];
    metricReaders: unknown[];
  };
}

beforeEach(() => {
  nodeSdkInstances.length = 0;
});

afterEach(async () => {
  await shutdownTelemetry();
  vi.restoreAllMocks();
});

describe('initializeTelemetry', () => {
  it('starts the constructed NodeSDK', () => {
    initializeTelemetry({ serviceName: 'svc' });
    expect(nodeSdkInstances[0].start).toHaveBeenCalledOnce();
  });

  it('passes the service name through', () => {
    initializeTelemetry({ serviceName: 'billing-service' });
    expect(lastSdkConfig().serviceName).toBe('billing-service');
  });

  it('builds one processor per enabled signal', () => {
    initializeTelemetry({ serviceName: 'svc', endpoint: 'http://collector:4318' });
    const config = lastSdkConfig();
    expect(config.spanProcessors).toHaveLength(1);
    expect(config.logRecordProcessors).toHaveLength(1);
    expect(config.metricReaders).toHaveLength(1);
  });

  it('passes explicit empty arrays — never undefined — for disabled signals', () => {
    initializeTelemetry({
      serviceName: 'svc',
      traces: { enabled: false },
      logs: { enabled: false },
      metrics: { enabled: false },
    });
    const config = lastSdkConfig();
    expect(config.spanProcessors).toEqual([]);
    expect(config.logRecordProcessors).toEqual([]);
    expect(config.metricReaders).toEqual([]);
    expect(config.spanProcessors).not.toBeUndefined();
    expect(config.logRecordProcessors).not.toBeUndefined();
    expect(config.metricReaders).not.toBeUndefined();
  });

  it('builds only the enabled signals when partially disabled', () => {
    initializeTelemetry({ serviceName: 'svc', metrics: { enabled: false } });
    const config = lastSdkConfig();
    expect(config.spanProcessors).toHaveLength(1);
    expect(config.logRecordProcessors).toHaveLength(1);
    expect(config.metricReaders).toEqual([]);
  });

  it('leaves resource undefined when no environment is configured', () => {
    initializeTelemetry({ serviceName: 'svc' });
    expect(lastSdkConfig().resource).toBeUndefined();
  });

  it('builds a resource carrying deployment.environment.name when environment is configured', () => {
    initializeTelemetry({ serviceName: 'svc', environment: 'staging' });
    expect(lastSdkConfig().resource?.attributes[ATTR_DEPLOYMENT_ENVIRONMENT_NAME]).toBe('staging');
  });

  it('registers SIGTERM and SIGINT handlers that shut the SDK down', () => {
    const onSpy = vi.spyOn(process, 'once');
    initializeTelemetry({ serviceName: 'svc' });
    expect(onSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    expect(onSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
  });

  it('is idempotent: a second call while already initialized does not start a second NodeSDK', () => {
    initializeTelemetry({ serviceName: 'first' });
    initializeTelemetry({ serviceName: 'second' });

    expect(nodeSdkInstances).toHaveLength(1);
    expect(lastSdkConfig().serviceName).toBe('first');
  });

  it('returns the already-active SDK instance on a redundant call', () => {
    const first = initializeTelemetry({ serviceName: 'svc' });
    const second = initializeTelemetry({ serviceName: 'svc' });
    expect(second).toBe(first);
  });

  it('starts a new SDK again after an explicit shutdownTelemetry()', async () => {
    initializeTelemetry({ serviceName: 'first' });
    await shutdownTelemetry();
    initializeTelemetry({ serviceName: 'second' });

    expect(nodeSdkInstances).toHaveLength(2);
    expect(lastSdkConfig().serviceName).toBe('second');
  });
});

describe('shutdownTelemetry', () => {
  it('shuts down the active SDK', async () => {
    initializeTelemetry({ serviceName: 'svc' });
    await shutdownTelemetry();
    expect(nodeSdkInstances[0].shutdown).toHaveBeenCalledOnce();
  });

  it('is a no-op when no SDK was initialized', async () => {
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
  });

  it('is a no-op the second time it is called', async () => {
    initializeTelemetry({ serviceName: 'svc' });
    await shutdownTelemetry();
    await shutdownTelemetry();
    expect(nodeSdkInstances[0].shutdown).toHaveBeenCalledOnce();
  });

  it('removes the SIGTERM/SIGINT listeners it registered, so repeated cycles do not leak them', async () => {
    const before = process.listenerCount('SIGTERM');
    initializeTelemetry({ serviceName: 'svc' });
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);

    await shutdownTelemetry();
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });
});
