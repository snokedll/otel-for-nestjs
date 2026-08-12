/**
 * Partial-match criteria used to skip instrumentation for a message
 * event — e.g. `{ body: { name: 'HEALTH_CHECK' } }` matches any event
 * whose body has `name === 'HEALTH_CHECK'`, regardless of its other
 * fields.
 */
export interface EventIgnoreRule {
  /** Criteria matched against the event's deserialized body. */
  body?: Record<string, unknown>;
  /** Criteria matched against the event's headers. */
  headers?: Record<string, unknown>;
}

/** A route to skip instrumentation for: an exact path match, or a pattern tested against the path. */
export type RoutePattern = string | RegExp;

function matchesPattern(path: string, pattern: RoutePattern): boolean {
  if (typeof pattern === 'string') return pattern === path;
  return pattern instanceof RegExp && pattern.test(path);
}

/**
 * @param path the request path (query string, if any, is ignored).
 * @param ignoreRoutes patterns to match `path` against. A malformed entry
 * (neither a string nor a `RegExp`) never matches, rather than throwing —
 * one bad entry in an otherwise-valid list must not take every request down.
 * @returns whether `path` matches any entry in `ignoreRoutes`.
 */
export function isRouteIgnored(path: string, ignoreRoutes: RoutePattern[]): boolean {
  if (ignoreRoutes.length === 0) return false;

  const cleanPath = path.split('?')[0];
  return ignoreRoutes.some((pattern) => matchesPattern(cleanPath, pattern));
}

/**
 * Recursively checks that every field present in `expected` also matches
 * in `actual`; fields present only in `actual` are ignored. Recursion
 * depth is bounded by `expected`'s own structure (application-authored
 * configuration), never by `actual` (attacker-controlled request/event
 * data), so an arbitrarily deep `actual` cannot force deep recursion.
 */
function deepPartialMatch(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== 'object') return actual === expected;
  if (actual === null || typeof actual !== 'object') return false;

  return Object.entries(expected as Record<string, unknown>).every(([key, value]) =>
    deepPartialMatch((actual as Record<string, unknown>)[key], value),
  );
}

/**
 * @param ignoreEvents rules to match the event against; see {@link EventIgnoreRule}.
 * @param body the event's deserialized body.
 * @param headers the event's headers.
 * @returns whether the event matches any rule in `ignoreEvents`.
 */
export function isEventIgnored(ignoreEvents: EventIgnoreRule[], body: unknown, headers: Record<string, unknown>): boolean {
  return ignoreEvents.some((rule) => {
    if (rule.body === undefined && rule.headers === undefined) return false;
    if (rule.body !== undefined && !deepPartialMatch(body, rule.body)) return false;
    if (rule.headers !== undefined && !deepPartialMatch(headers, rule.headers)) return false;
    return true;
  });
}
