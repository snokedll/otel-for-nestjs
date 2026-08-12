/**
 * Asserts that a decorated member's property key is a string, as required
 * by every method decorator in this SDK (symbol-keyed methods have no
 * sensible default span/metric name).
 *
 * @param propertyKey the decorated member's key.
 * @param decoratorName the decorator's name, used in the thrown message.
 */
export function assertStringPropertyKey(propertyKey: string | symbol, decoratorName: string): asserts propertyKey is string {
  if (typeof propertyKey !== 'string') {
    throw new Error(`${decoratorName} can only decorate methods with a string name.`);
  }
}

/** @returns `ClassName.methodName`, used as the default span/metric name when none is configured. */
export function resolveDefaultName(target: object, propertyKey: string): string {
  const className = (target as { constructor?: { name?: string } }).constructor?.name ?? 'Unknown';
  return `${className}.${propertyKey}`;
}

/**
 * Copies `source.name` onto `wrapper`.
 *
 * A wrapper function assigned via `const wrapped = function () {}` gets
 * its OWN name inferred from the variable binding (`"wrapped"`), per
 * ECMAScript's NamedEvaluation — not the original method's name. Anything
 * reading `.name` off the final decorated method (Nest's `ExecutionContext.
 * getHandler().name`, used by this SDK's own route metric label) would
 * silently see the wrong value without this.
 *
 * @param source the original, undecorated method.
 * @param wrapper the function that replaces it.
 */
export function preserveFunctionName(source: (...args: unknown[]) => unknown, wrapper: (...args: unknown[]) => unknown): void {
  Object.defineProperty(wrapper, 'name', { value: source.name, configurable: true });
}
