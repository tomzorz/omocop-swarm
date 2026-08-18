import { describe, expect, it } from 'vitest';
import { API_ENDPOINT } from '../../src/config.js';
import { FoursquareClient } from '../../src/foursquare/client.js';
import { describeApiError, FoursquareError, sanitizeUrl } from '../../src/foursquare/errors.js';
import { createLogger } from '../../src/logging.js';
import { FakeFoursquare } from '../support/fake-foursquare.js';

const logs: string[] = [];
const logger = () => {
  logs.length = 0;
  return createLogger('debug', (chunk) => logs.push(chunk));
};

const client = (fake: FakeFoursquare, overrides: Record<string, unknown> = {}) =>
  new FoursquareClient({
    endpoint: API_ENDPOINT,
    apiVersion: '20250401',
    token: 'test-token',
    logger: logger(),
    fetchImpl: fake.fetch,
    sleep: async () => undefined,
    ...overrides,
  });

describe('request building', () => {
  it('adds the pinned version and the token to every request', async () => {
    const fake = new FakeFoursquare();
    await client(fake).get('users/self');
    expect(fake.requests[0]?.params).toMatchObject({ v: '20250401', oauth_token: 'test-token' });
  });

  it('does not compute the version from today, which would opt into future changes', async () => {
    const fake = new FakeFoursquare();
    await client(fake).get('users/self');
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    expect(fake.requests[0]?.params['v']).not.toBe(today);
  });

  it('passes through the query it is given and drops undefined values', async () => {
    const fake = new FakeFoursquare();
    await client(fake).get('users/self/checkins', { limit: 250, offset: 0, sort: undefined });
    expect(fake.requests[0]?.params).toMatchObject({ limit: '250', offset: '0' });
    expect(fake.requests[0]?.params['sort']).toBeUndefined();
  });

  it('returns the envelope body, not the envelope', async () => {
    const fake = new FakeFoursquare();
    const response = await client(fake).get<{ user: { firstName: string } }>('users/self');
    expect(response.user.firstName).toBe('Test');
  });
});

describe('the envelope', () => {
  it('treats an error code inside a 200 as a failure', async () => {
    const fake = new FakeFoursquare();
    // HTTP 200, envelope says 500. Trusting the status would hand the caller an
    // empty response object as though the account were empty.
    fake.failNext({ status: 500, times: 10, inEnvelopeOnly: true });

    await expect(client(fake, { maxAttempts: 2 }).get('users/self')).rejects.toBeInstanceOf(
      FoursquareError,
    );
  });

  it('reports a deprecation warning once and still returns the data', async () => {
    const fake = new FakeFoursquare({ warnErrorType: 'deprecated' });
    const instance = client(fake);

    const first = await instance.get<{ user: unknown }>('users/self');
    await instance.get('users/self');

    expect(first.user).toBeDefined();
    expect(logs.filter((line) => line.includes('deprecated'))).toHaveLength(1);
  });

  it('surfaces the API error detail rather than a bare status', async () => {
    const fake = new FakeFoursquare({ token: 'a-different-token' });
    await expect(client(fake).get('users/self')).rejects.toThrow(/OAuth token invalid or revoked/);
  });

  it('carries the error type through', async () => {
    const fake = new FakeFoursquare({ token: 'other' });
    await expect(client(fake).get('users/self')).rejects.toMatchObject({
      errorType: 'invalid_auth',
      status: 401,
    });
  });
});

describe('retry and backoff', () => {
  it('retries a 429 and succeeds', async () => {
    const fake = new FakeFoursquare();
    fake.failNext({ status: 429, times: 2 });
    const response = await client(fake).get<{ user: unknown }>('users/self');
    expect(response.user).toBeDefined();
    expect(fake.requests).toHaveLength(3);
  });

  it('retries a 5xx and succeeds', async () => {
    const fake = new FakeFoursquare();
    fake.failNext({ status: 503, times: 1 });
    await expect(client(fake).get('users/self')).resolves.toBeDefined();
  });

  it('gives up after the attempt budget and throws the real error', async () => {
    const fake = new FakeFoursquare();
    fake.failNext({ status: 500, times: 99 });
    await expect(client(fake, { maxAttempts: 3 }).get('users/self')).rejects.toBeInstanceOf(
      FoursquareError,
    );
    expect(fake.requests).toHaveLength(3);
  });

  it('does not retry a 4xx that is not a rate limit', async () => {
    const fake = new FakeFoursquare({ token: 'other' });
    await expect(client(fake, { maxAttempts: 4 }).get('users/self')).rejects.toThrow();
    expect(fake.requests).toHaveLength(1);
  });

  it('honours Retry-After over its own backoff', async () => {
    const fake = new FakeFoursquare();
    fake.failNext({ status: 429, times: 1, retryAfter: '2' });
    const waits: number[] = [];
    await client(fake, { sleep: async (ms: number) => void waits.push(ms) }).get('users/self');
    expect(waits).toEqual([2000]);
  });

  it('caps a hostile Retry-After at the configured ceiling', async () => {
    const fake = new FakeFoursquare();
    fake.failNext({ status: 429, times: 1, retryAfter: '86400' });
    const waits: number[] = [];
    await client(fake, {
      maxBackoffMs: 5_000,
      sleep: async (ms: number) => void waits.push(ms),
    }).get('users/self');
    expect(waits).toEqual([5_000]);
  });

  it('backs off with jitter when no Retry-After is given', async () => {
    const fake = new FakeFoursquare();
    fake.failNext({ status: 503, times: 3 });
    const waits: number[] = [];
    await client(fake, {
      maxAttempts: 5,
      sleep: async (ms: number) => void waits.push(ms),
    }).get('users/self');

    expect(waits).toHaveLength(3);
    // Full jitter: each wait sits between half the ceiling and the ceiling.
    for (const [attempt, wait] of waits.entries()) {
      const ceiling = 2 ** (attempt + 1) * 500;
      expect(wait).toBeGreaterThanOrEqual(ceiling / 2);
      expect(wait).toBeLessThanOrEqual(ceiling);
    }
  });

  it('retries a transport failure and translates it when it runs out', async () => {
    let calls = 0;
    const failing: typeof fetch = async () => {
      calls += 1;
      throw new TypeError('fetch failed');
    };
    await expect(
      new FoursquareClient({
        endpoint: API_ENDPOINT,
        apiVersion: '20250401',
        token: 'test-token',
        logger: logger(),
        fetchImpl: failing,
        sleep: async () => undefined,
        maxAttempts: 3,
      }).get('users/self'),
    ).rejects.toMatchObject({ errorType: 'NetworkError', status: 0 });
    expect(calls).toBe(3);
  });
});

describe('keeping the token out of everything it touches', () => {
  it('never puts the token in a log line', async () => {
    const fake = new FakeFoursquare();
    fake.failNext({ status: 429, times: 1 });
    await client(fake).get('users/self');
    expect(logs.join('')).not.toContain('test-token');
    expect(logs.join('')).toContain('<redacted>');
  });

  it('never puts the token in a thrown error, which the logger never sees', async () => {
    const fake = new FakeFoursquare({ token: 'other' });
    await expect(client(fake).get('users/self')).rejects.toSatisfy(
      (error: FoursquareError) =>
        !error.path.includes('test-token') && !JSON.stringify(error).includes('test-token'),
    );
  });

  it('sanitizes every credential-shaped parameter', () => {
    const url = 'https://api.foursquare.com/v2/x?oauth_token=abc&v=1&client_secret=def&access_token=ghi';
    const clean = sanitizeUrl(url);
    expect(clean).not.toContain('abc');
    expect(clean).not.toContain('def');
    expect(clean).not.toContain('ghi');
    expect(clean).toContain('v=1');
  });
});

describe('describeApiError', () => {
  const error = (type: string, status = 400) =>
    new FoursquareError(status, type, 'detail here', 'req-1', 'GET', 'users/self/checkins');

  it('tells an invalid token what to run', () => {
    expect(describeApiError(error('invalid_auth', 401))).toMatch(/omocop-swarm auth/);
  });

  it('tells a rate limit that the sync resumes', () => {
    expect(describeApiError(error('rate_limit_exceeded', 429))).toMatch(/resumes/);
  });

  it('says a param error is the tool\'s fault, not the caller\'s', () => {
    expect(describeApiError(error('param_error'))).toMatch(/bug in the request this tool built/);
  });

  it('gives a 5xx the resume advice too', () => {
    expect(describeApiError(error('unknown_error', 503))).toMatch(/last saved position/);
  });

  it('includes the request id when there is one, for a support conversation', () => {
    expect(describeApiError(error('endpoint_error', 404))).toContain('req-1');
  });
});
