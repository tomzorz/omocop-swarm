/**
 * Foursquare v2 errors, and translating them into something actionable.
 *
 * v2 wraps every response in an envelope:
 *
 *     { "meta": { "code": 401, "errorType": "invalid_auth",
 *                 "errorDetail": "OAuth token invalid or revoked.",
 *                 "requestId": "..." },
 *       "response": { ... } }
 *
 * Two consequences that a plain `if (!response.ok)` misses:
 *
 *   1. **`meta.code` is the real status.** A proxy or a partial outage can
 *      produce an HTTP 200 whose envelope says 500, and treating that as success
 *      hands the caller an empty `response` object as though the account had no
 *      check-ins. Both are checked, and the envelope wins.
 *   2. **`errorType: "deprecated"` arrives on a 200.** It is the documented way
 *      Foursquare marks a retired endpoint, and it is a warning rather than a
 *      failure — the data is still there. It must be surfaced loudly and must
 *      not stop the sync.
 */

export interface ApiMeta {
  readonly code?: number;
  readonly errorType?: string;
  readonly errorDetail?: string;
  readonly requestId?: string;
}

export class FoursquareError extends Error {
  override readonly name = 'FoursquareError';

  constructor(
    /** HTTP status, or 0 when the request never got a response. */
    readonly status: number,
    readonly errorType: string,
    override readonly message: string,
    readonly requestId: string | undefined,
    readonly method: string,
    readonly path: string,
  ) {
    super(message);
  }
}

/**
 * Strips credentials out of a URL before it can reach a log or a message.
 *
 * The token travels as a query parameter, which is what this endpoint
 * documents, so every place a URL is written down is a place it could leak.
 * The logger redacts as well; this is the belt to that pair of braces, and it
 * is the one that keeps the token out of thrown error messages, which the
 * logger never sees.
 */
export function sanitizeUrl(url: string): string {
  return url.replace(/([?&](?:oauth_token|access_token|client_secret)=)[^&]*/gi, '$1<redacted>');
}

/** Reads the envelope, whatever shape the body turned out to be. */
export function readMeta(body: unknown): ApiMeta {
  if (typeof body !== 'object' || body === null) return {};
  const meta = (body as Record<string, unknown>)['meta'];
  if (typeof meta !== 'object' || meta === null) return {};
  const record = meta as Record<string, unknown>;
  return {
    ...(typeof record['code'] === 'number' ? { code: record['code'] } : {}),
    ...(typeof record['errorType'] === 'string' ? { errorType: record['errorType'] } : {}),
    ...(typeof record['errorDetail'] === 'string' ? { errorDetail: record['errorDetail'] } : {}),
    ...(typeof record['requestId'] === 'string' ? { requestId: record['requestId'] } : {}),
  };
}

/** Builds an error from a failed response, preferring the envelope's account of it. */
export function parseApiError(
  status: number,
  body: unknown,
  rawBody: string,
  method: string,
  path: string,
): FoursquareError {
  const meta = readMeta(body);
  const message =
    meta.errorDetail ??
    (rawBody.trim() !== '' && rawBody.length < 300 ? rawBody.trim() : `HTTP ${status}`);
  return new FoursquareError(
    meta.code ?? status,
    meta.errorType ?? 'unknown_error',
    message,
    meta.requestId,
    method,
    sanitizeUrl(path),
  );
}

/**
 * Turns an error into the sentence a user needs.
 *
 * Every branch says what to do next. A bare "401 invalid_auth" is accurate and
 * useless: the reader still has to know that Foursquare tokens are revoked when
 * an app's permissions change, and that the fix is one command.
 */
export function describeApiError(error: FoursquareError): string {
  const where = `${error.method} ${error.path}`;
  const trace = error.requestId ? ` (Foursquare request ${error.requestId})` : '';

  switch (error.errorType) {
    case 'invalid_auth':
    case 'unauthorized':
      return (
        `Foursquare rejected the token: ${error.message}\n\n` +
        'A v2 user token does not expire on a timer, but it is revoked if the app ' +
        'registration changes or you disconnect the app. Run `omocop-swarm auth` to sign ' +
        'in again. Nothing already in the local archive is affected.'
      );
    case 'rate_limit_exceeded':
      return (
        `Foursquare is rate limiting this token: ${error.message}\n\n` +
        'The sync backs off and retries on its own; seeing this means it ran out of ' +
        'attempts. Wait for the hour to roll over and run `omocop-swarm sync` again — it ' +
        'resumes from where it stopped rather than starting over.'
      );
    case 'param_error':
      return (
        `Foursquare rejected a parameter on ${where}: ${error.message}${trace}\n\n` +
        'This is a bug in the request this tool built, not in what you asked for.'
      );
    case 'deprecated':
      return (
        `Foursquare reports ${where} as deprecated: ${error.message}${trace}\n\n` +
        'Run a sync soon if the archive is behind — a deprecated endpoint is on a clock.'
      );
    case 'endpoint_error':
      return `Foursquare has no such endpoint as ${where}: ${error.message}${trace}`;
    case 'NetworkError':
      return (
        `${where} failed before a response arrived: ${error.message}\n\n` +
        'Nothing was lost. Re-run the command; a sync resumes from its last saved position.'
      );
    default:
      if (error.status >= 500) {
        return (
          `Foursquare returned a server error on ${where}: ${error.message}${trace}\n\n` +
          'Re-run the command later; a sync resumes from its last saved position.'
        );
      }
      return `${where} failed (${error.status} ${error.errorType}): ${error.message}${trace}`;
  }
}
