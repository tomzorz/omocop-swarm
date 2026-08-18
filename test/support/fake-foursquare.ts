/**
 * A fake `/users/self/checkins`.
 *
 * Not a mock. It holds a real collection and implements the endpoint's actual
 * rules over it — newest-first ordering, `limit` capped at 250, offsets into
 * that ordering, the `meta`/`response` envelope, and the mandatory `v` and
 * `oauth_token`. A request that would be rejected by Foursquare is rejected
 * here.
 *
 * That is the point. The sync's correctness rests on assumptions about paging,
 * and a fake that answers whatever it is asked cannot test them: the
 * off-by-one that skips a check-in at a page boundary only appears against
 * something that pages properly. Do not weaken it to make a test pass.
 *
 * The undocumented parameters are switchable, because whether they work is the
 * one thing the real API has not committed to. Each combination is a supported
 * configuration of the sync, so each is a configuration of this fake.
 */

export interface FakeSupport {
  readonly afterTimestamp: boolean;
  readonly beforeTimestamp: boolean;
  readonly sortOldestFirst: boolean;
}

export interface ScriptedFailure {
  /** HTTP status to answer with. */
  readonly status: number;
  /** How many consecutive requests it applies to. */
  readonly times: number;
  readonly retryAfter?: string;
  /** Answer with HTTP 200 but an error code in the envelope. */
  readonly inEnvelopeOnly?: boolean;
}

export interface FakeOptions {
  readonly checkins?: ReadonlyArray<Record<string, unknown>>;
  readonly supports?: Partial<FakeSupport>;
  readonly token?: string;
  /** Attached to every successful envelope, e.g. `deprecated`. */
  readonly warnErrorType?: string;
}

export interface RecordedRequest {
  readonly path: string;
  readonly params: Record<string, string>;
}

const MAX_LIMIT = 250;

export class FakeFoursquare {
  private checkins: Array<Record<string, unknown>>;
  private readonly supports: FakeSupport;
  private readonly token: string;
  private readonly warnErrorType: string | undefined;
  private failures: ScriptedFailure[] = [];

  readonly requests: RecordedRequest[] = [];

  constructor(options: FakeOptions = {}) {
    this.checkins = [...(options.checkins ?? [])];
    this.supports = {
      afterTimestamp: options.supports?.afterTimestamp ?? true,
      beforeTimestamp: options.supports?.beforeTimestamp ?? true,
      sortOldestFirst: options.supports?.sortOldestFirst ?? true,
    };
    this.token = options.token ?? 'test-token';
    this.warnErrorType = options.warnErrorType;
  }

  /** Queues failures to answer the next requests with. */
  failNext(failure: ScriptedFailure): void {
    this.failures.push(failure);
  }

  /** Adds a check-in as though it had just happened, to test shifting offsets. */
  add(checkin: Record<string, unknown>): void {
    this.checkins.push(checkin);
  }

  get count(): number {
    return this.checkins.length;
  }

  /** How many requests carried a given parameter. */
  requestsWith(parameter: string): number {
    return this.requests.filter((request) => parameter in request.params).length;
  }

  readonly fetch: typeof fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : String(input));
    const params = Object.fromEntries(url.searchParams.entries());
    this.requests.push({ path: url.pathname, params });

    const failure = this.failures[0];
    if (failure) {
      if (failure.times <= 1) this.failures.shift();
      else this.failures[0] = { ...failure, times: failure.times - 1 };
      return this.error(
        failure.inEnvelopeOnly ? 200 : failure.status,
        failure.status,
        'server_error',
        'scripted failure',
        failure.retryAfter,
      );
    }

    if (params['v'] === undefined || params['v'] === '') {
      return this.error(400, 400, 'param_error', 'Must provide parameter v');
    }
    if (params['oauth_token'] !== this.token) {
      return this.error(401, 401, 'invalid_auth', 'OAuth token invalid or revoked.');
    }

    if (url.pathname.endsWith('/users/self')) {
      return this.ok({ user: { id: '1', firstName: 'Test', lastName: 'User' } });
    }
    if (!url.pathname.endsWith('/users/self/checkins')) {
      return this.error(404, 404, 'endpoint_error', 'The requested path does not exist.');
    }

    const limit = clampLimit(params['limit']);
    const offset = Math.max(0, Number(params['offset'] ?? 0) || 0);

    // The collection is always ordered newest-first before anything else is
    // applied, because that is what the endpoint does and cannot be told not to.
    let ordered = [...this.checkins].sort(
      (a, b) => Number(b['createdAt']) - Number(a['createdAt']),
    );

    // `count` is the size of the filtered collection, not of the page.
    if (this.supports.afterTimestamp && params['afterTimestamp'] !== undefined) {
      const after = Number(params['afterTimestamp']);
      ordered = ordered.filter((checkin) => Number(checkin['createdAt']) > after);
    }
    if (this.supports.beforeTimestamp && params['beforeTimestamp'] !== undefined) {
      const before = Number(params['beforeTimestamp']);
      ordered = ordered.filter((checkin) => Number(checkin['createdAt']) < before);
    }
    if (this.supports.sortOldestFirst && params['sort'] === 'oldestfirst') {
      ordered = ordered.reverse();
    }

    return this.ok({
      checkins: { count: ordered.length, items: ordered.slice(offset, offset + limit) },
    });
  };

  private ok(response: unknown): Response {
    const meta: Record<string, unknown> = { code: 200, requestId: 'fake' };
    if (this.warnErrorType) {
      meta['errorType'] = this.warnErrorType;
      meta['errorDetail'] = 'This endpoint is deprecated.';
    }
    return new Response(JSON.stringify({ meta, response }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private error(
    httpStatus: number,
    metaCode: number,
    errorType: string,
    errorDetail: string,
    retryAfter?: string,
  ): Response {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (retryAfter) headers['Retry-After'] = retryAfter;
    return new Response(
      JSON.stringify({ meta: { code: metaCode, errorType, errorDetail, requestId: 'fake' }, response: {} }),
      { status: httpStatus, headers },
    );
  }
}

/** The endpoint caps `limit` rather than rejecting an oversized one. */
function clampLimit(raw: string | undefined): number {
  const parsed = Number(raw ?? 20);
  if (!Number.isFinite(parsed) || parsed < 1) return 20;
  return Math.min(Math.floor(parsed), MAX_LIMIT);
}
