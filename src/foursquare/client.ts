/**
 * The Foursquare v2 client.
 *
 * Small on purpose. This archive reads one endpoint family, so the client's job
 * is not breadth — it is making every request carry the two things v2 demands
 * (`oauth_token` and `v`), unwrapping the envelope, and being the single place
 * that knows how to wait.
 *
 * On waiting: Foursquare is not aggressive about rate limiting, which is
 * precisely why the backoff has to be here rather than left for later. A
 * backfill is the one operation that issues hundreds of requests in a row, it
 * is the one most likely to trip a limit, and it is the one where giving up
 * halfway costs the most. Retrying is cheap; discovering you needed it at hour
 * two of a backfill is not.
 */
import { FoursquareError, parseApiError, readMeta, sanitizeUrl } from './errors.js';
import type { Logger } from '../logging.js';

export type QueryValue = string | number | boolean | undefined;

export interface ClientOptions {
  readonly endpoint: string;
  /** The pinned `v=YYYYMMDD`. */
  readonly apiVersion: string;
  /** The user OAuth token. */
  readonly token: string;
  readonly logger: Logger;
  /** Attempts per request, including the first. Default 5. */
  readonly maxAttempts?: number;
  /** Ceiling on a single backoff wait, ms. Default 60000. */
  readonly maxBackoffMs?: number;
  /** Injectable for tests. */
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Retry-After is either seconds or an HTTP date. Both appear in the wild. */
function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const when = Date.parse(header);
  return Number.isNaN(when) ? undefined : Math.max(0, when - Date.now());
}

export class FoursquareClient {
  private readonly endpoint: string;
  private readonly apiVersion: string;
  private readonly token: string;
  private readonly logger: Logger;
  private readonly maxAttempts: number;
  private readonly maxBackoffMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  /** Deprecation notices already reported, so a backfill says it once. */
  private readonly warned = new Set<string>();

  constructor(options: ClientOptions) {
    this.endpoint = options.endpoint.endsWith('/') ? options.endpoint : `${options.endpoint}/`;
    this.apiVersion = options.apiVersion;
    this.token = options.token;
    this.logger = options.logger;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /**
   * Builds a request URL.
   *
   * The token goes in `oauth_token`, which is what this endpoint's reference
   * documents. That places a credential in a URL, so nothing anywhere may log a
   * URL without running it through `sanitizeUrl` first — which is why this
   * method is private and `describe` exists.
   */
  private url(path: string, query: Record<string, QueryValue>): string {
    const url = new URL(path.replace(/^\//, ''), this.endpoint);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    url.searchParams.set('v', this.apiVersion);
    url.searchParams.set('oauth_token', this.token);
    return url.toString();
  }

  /** A URL safe to print. */
  private describe(path: string, query: Record<string, QueryValue>): string {
    return sanitizeUrl(this.url(path, query));
  }

  /**
   * GETs an endpoint and returns the envelope's `response`.
   *
   * @throws FoursquareError for a transport failure, a non-2xx status, or an
   *   envelope whose `meta.code` is an error — including when the HTTP status
   *   disagreed and said 200.
   */
  async get<T>(path: string, query: Record<string, QueryValue> = {}): Promise<T> {
    const url = this.url(path, query);
    const safe = this.describe(path, query);

    for (let attempt = 1; ; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });
      } catch (cause) {
        // `fetch` rejects DNS failures and connection resets with a bare
        // TypeError naming neither the request nor the target; untranslated,
        // the caller sees "fetch failed" and cannot tell which call died.
        const error = new FoursquareError(
          0,
          'NetworkError',
          cause instanceof Error ? cause.message : String(cause),
          undefined,
          'GET',
          safe,
        );
        if (attempt < this.maxAttempts) {
          const wait = this.backoffMs(attempt, null);
          this.logger.warn(
            `GET ${safe} failed before a response (${error.message}); retrying in ${wait}ms ` +
              `(attempt ${attempt} of ${this.maxAttempts})`,
          );
          await this.sleep(wait);
          continue;
        }
        throw error;
      }

      this.noteRateLimit(response, safe);

      const text = await response.text();
      let body: unknown;
      try {
        body = text === '' ? {} : JSON.parse(text);
      } catch {
        body = undefined;
      }

      const meta = readMeta(body);
      const effectiveStatus = meta.code ?? response.status;
      const failed = effectiveStatus >= 400 || (!response.ok && meta.code === undefined);

      if (!failed) {
        if (body === undefined) {
          throw new FoursquareError(
            response.status,
            'InvalidJsonResponse',
            'Foursquare returned a body that is not JSON.',
            undefined,
            'GET',
            safe,
          );
        }
        // A deprecation notice rides along with a perfectly good 200. Reporting
        // it must not fail the call, and must not repeat once per page.
        if (meta.errorType === 'deprecated' && !this.warned.has(path)) {
          this.warned.add(path);
          this.logger.warn(
            `Foursquare reports ${path} as deprecated: ${meta.errorDetail ?? 'no detail given'}. ` +
              'The data is still being returned. Keep the archive current.',
          );
        }
        return ((body as Record<string, unknown>)['response'] ?? {}) as T;
      }

      const error = parseApiError(response.status, body, text, 'GET', safe);

      // Every request here is a GET, so repeating one is always safe: there is
      // no operation that could have completed server-side before the gateway
      // gave up. 429 and 5xx both retry.
      const retryable =
        effectiveStatus === 429 || (effectiveStatus >= 500 && effectiveStatus < 600);

      if (retryable && attempt < this.maxAttempts) {
        const wait = this.backoffMs(attempt, response.headers.get('retry-after'));
        this.logger.warn(
          `GET ${safe} returned ${effectiveStatus} (${error.errorType}); retrying in ${wait}ms ` +
            `(attempt ${attempt} of ${this.maxAttempts})`,
        );
        await this.sleep(wait);
        continue;
      }

      throw error;
    }
  }

  /**
   * Foursquare's own Retry-After wins; the exponential fallback covers silence.
   *
   * Full jitter on the fallback. Without it, several requests that were
   * throttled together come back in lockstep and get throttled together again.
   */
  private backoffMs(attempt: number, retryAfter: string | null): number {
    const stated = retryAfterMs(retryAfter);
    if (stated !== undefined) return Math.min(stated, this.maxBackoffMs);
    const ceiling = Math.min(2 ** attempt * 500, this.maxBackoffMs);
    return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
  }

  /** Logs the remaining quota when it gets low enough to matter. */
  private noteRateLimit(response: Response, safe: string): void {
    const remaining = Number(response.headers.get('x-ratelimit-remaining'));
    if (!Number.isFinite(remaining)) return;
    const limit = Number(response.headers.get('x-ratelimit-limit'));
    this.logger.debug(
      `rate limit: ${remaining}${Number.isFinite(limit) ? `/${limit}` : ''} remaining`,
    );
    if (remaining <= 10) {
      this.logger.warn(
        `Only ${remaining} API calls left in this window for ${safe}. ` +
          'A sync interrupted here resumes from its saved position.',
      );
    }
  }
}
