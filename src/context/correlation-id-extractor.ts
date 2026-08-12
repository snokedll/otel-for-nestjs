/** Transport a {@link CorrelationIdSource} applies to. */
export enum CorrelationSource {
  HTTP = 'http',
  MESSAGE = 'message',
}

/** Where to look for a correlation identifier. */
export interface CorrelationIdSource {
  /**
   * `'header'` reads a header (case-insensitive) from HTTP requests or
   * message headers. `'body'` reads a dot-notation path (e.g.
   * `'data.correlationId'`) from an already-deserialized request or
   * message body.
   */
  from: 'header' | 'body';
  /** Header name, or dot-notation body path. */
  key: string;
  /**
   * Restricts this source to `CorrelationSource.HTTP` (requests, handled by
   * `HttpTraceInterceptor`) or `CorrelationSource.MESSAGE` (events, handled
   * by `MessageTraceInterceptor`). Omitted: the source is tried for both.
   */
  source?: CorrelationSource;
}

/** Default source list: `x-correlation-id`, `correlation-id`, `correlationId` headers, in that order. Applies to both HTTP requests and messages. */
export const DEFAULT_CORRELATION_ID_SOURCES: CorrelationIdSource[] = [
  { from: 'header', key: 'x-correlation-id' },
  { from: 'header', key: 'correlation-id' },
  { from: 'header', key: 'correlationId' },
];

/** Property names rejected by {@link resolveBodyPath} to keep prototype-chain traversal impossible. */
const UNSAFE_PATH_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

function resolveHeader(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function resolveBodyPath(body: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, segment) => {
    if (UNSAFE_PATH_SEGMENTS.has(segment)) return undefined;
    if (current === null || typeof current !== 'object') return undefined;
    return Object.prototype.hasOwnProperty.call(current, segment)
      ? (current as Record<string, unknown>)[segment]
      : undefined;
  }, body);
}

type SourceResolver = (source: CorrelationIdSource, headers: Record<string, string | string[] | undefined>, body: unknown) => string | undefined;

const resolversByType: Record<CorrelationIdSource['from'], SourceResolver> = {
  header: (source, headers) => resolveHeader(headers, source.key),
  body: (source, _headers, body) => {
    const value = resolveBodyPath(body, source.key);
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  },
};

/**
 * Resolves a correlation identifier by trying each of `sources` in order
 * and returning the first non-empty value found. A source whose `source`
 * field is set is skipped unless it matches `transport`.
 *
 * @param sources ordered list of places to look; see {@link CorrelationIdSource}.
 * @param headers request or message headers, keyed in lowercase.
 * @param body already-deserialized request or message body, consulted only for `from: 'body'` sources.
 * @param transport the transport currently resolving a correlation id — `HttpTraceInterceptor`/`MessageTraceInterceptor` pass their own. Sources without a `source` field are tried regardless.
 * @returns the resolved correlation identifier, or `undefined` if no source matched.
 */
export function extractCorrelationId(
  sources: CorrelationIdSource[],
  headers: Record<string, string | string[] | undefined>,
  body?: unknown,
  transport?: CorrelationSource,
): string | undefined {
  for (const source of sources) {
    if (source.source !== undefined && transport !== undefined && source.source !== transport) continue;
    const value = resolversByType[source.from](source, headers, body);
    if (value) return value;
  }
  return undefined;
}
