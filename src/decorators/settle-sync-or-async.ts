/**
 * Invokes `run` and feeds its outcome through `onSuccess`/`onError`,
 * uniformly whether `run` returns synchronously, throws synchronously,
 * returns a `Promise`, or returns a rejected `Promise`.
 *
 * @param run the operation to invoke.
 * @param onSuccess called with the resolved value on success.
 * @param onError called with the thrown/rejected error on failure; must throw or return a rejection.
 * @returns whatever `onSuccess`/`onError` produce, preserving sync-vs-`Promise` shape.
 */
export function settleSyncOrAsync(
  run: () => unknown,
  onSuccess: (value: unknown) => unknown,
  onError: (error: unknown) => never,
): unknown {
  try {
    const result = run();
    return result instanceof Promise ? result.then(onSuccess, onError) : onSuccess(result);
  } catch (error) {
    return onError(error);
  }
}
