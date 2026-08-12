interface MetadataReflect {
  getMetadataKeys?(target: object, propertyKey?: string | symbol): unknown[];
  getMetadata?(metadataKey: unknown, target: object, propertyKey?: string | symbol): unknown;
  defineMetadata?(metadataKey: unknown, metadataValue: unknown, target: object, propertyKey?: string | symbol): void;
}

/**
 * Copies every `reflect-metadata` entry from `source` onto `target`.
 *
 * Framework method decorators (Nest's `@Get`, `@EventPattern`, `@Cron`,
 * guards, custom roles, ...) attach metadata directly to whichever
 * function object is in `descriptor.value` at the moment they run.
 * Decorators that replace `descriptor.value` with a wrapper — as method
 * decorators wrapping a call typically do — must call this before
 * discarding the original function, or metadata attached to it becomes
 * unreachable. Calling it makes the wrapping decorator's behavior
 * independent of its declaration order relative to those decorators.
 *
 * A no-op when `reflect-metadata` was never imported anywhere in the
 * process (the global `Reflect.getMetadataKeys` etc. are then absent).
 *
 * @param source the function that may already carry metadata.
 * @param target the function that should carry it going forward.
 */
export function copyMethodMetadata(source: object, target: object): void {
  const reflect = Reflect as typeof Reflect & MetadataReflect;
  if (typeof reflect.getMetadataKeys !== 'function') return;

  for (const key of reflect.getMetadataKeys(source)) {
    reflect.defineMetadata?.(key, reflect.getMetadata?.(key, source), target);
  }
}
