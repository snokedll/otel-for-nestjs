import { describe, it, expect, vi } from 'vitest';
import { settleSyncOrAsync } from '../../src/decorators/settle-sync-or-async';

describe('settleSyncOrAsync', () => {
  it('routes a synchronous return value through onSuccess', () => {
    const onSuccess = vi.fn((value: unknown) => value);
    const onError = vi.fn();

    const result = settleSyncOrAsync(() => 'sync-value', onSuccess, onError);

    expect(result).toBe('sync-value');
    expect(onSuccess).toHaveBeenCalledWith('sync-value');
    expect(onError).not.toHaveBeenCalled();
  });

  it('routes a synchronous throw through onError, without calling onSuccess', () => {
    const thrown = new Error('sync-fail');
    const onSuccess = vi.fn();
    const onError = vi.fn(() => {
      throw thrown;
    });

    expect(() => settleSyncOrAsync(() => { throw thrown; }, onSuccess, onError)).toThrow(thrown);
    expect(onError).toHaveBeenCalledWith(thrown);
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('routes a resolved promise through onSuccess, returning a promise', async () => {
    const onSuccess = vi.fn((value: unknown) => value);
    const onError = vi.fn();

    const result = settleSyncOrAsync(() => Promise.resolve('async-value'), onSuccess, onError);

    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBe('async-value');
    expect(onSuccess).toHaveBeenCalledWith('async-value');
  });

  it('routes a rejected promise through onError, returning a rejected promise', async () => {
    const thrown = new Error('async-fail');
    const onSuccess = vi.fn();
    const onError = vi.fn(() => {
      throw thrown;
    });

    const result = settleSyncOrAsync(() => Promise.reject(thrown), onSuccess, onError);

    await expect(result).rejects.toBe(thrown);
    expect(onError).toHaveBeenCalledWith(thrown);
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('lets onSuccess transform the resolved value', () => {
    const result = settleSyncOrAsync(
      () => 1,
      (value) => (value as number) * 10,
      (error) => {
        throw error;
      },
    );
    expect(result).toBe(10);
  });
});
