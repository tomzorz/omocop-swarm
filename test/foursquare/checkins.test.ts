import { describe, expect, it } from 'vitest';
import { API_ENDPOINT } from '../../src/config.js';
import { fetchCheckins, probeCapabilities } from '../../src/foursquare/checkins.js';
import { FoursquareClient } from '../../src/foursquare/client.js';
import { createLogger } from '../../src/logging.js';
import { FakeFoursquare, type FakeSupport } from '../support/fake-foursquare.js';
import { makeCheckins } from '../support/factory.js';

const silent = createLogger('error', () => undefined);

const clientFor = (fake: FakeFoursquare) =>
  new FoursquareClient({
    endpoint: API_ENDPOINT,
    apiVersion: '20250401',
    token: 'test-token',
    logger: silent,
    fetchImpl: fake.fetch,
    sleep: async () => undefined,
  });

describe('fetchCheckins', () => {
  it('returns the account total alongside the page', async () => {
    const fake = new FakeFoursquare({ checkins: makeCheckins(40) });
    const page = await fetchCheckins(clientFor(fake), { limit: 10, offset: 0 });
    expect(page.count).toBe(40);
    expect(page.items).toHaveLength(10);
  });

  it('pages through the collection without repeating or skipping', async () => {
    const fake = new FakeFoursquare({ checkins: makeCheckins(25) });
    const client = clientFor(fake);
    const seen: string[] = [];
    for (let offset = 0; offset < 25; offset += 10) {
      const page = await fetchCheckins(client, { limit: 10, offset });
      seen.push(...page.items.map((item) => String(item['id'])));
    }
    expect(new Set(seen).size).toBe(25);
  });

  it('returns newest first, which is the order that cannot be turned off', async () => {
    const fake = new FakeFoursquare({ checkins: makeCheckins(5) });
    const page = await fetchCheckins(clientFor(fake), { limit: 5, offset: 0 });
    const times = page.items.map((item) => Number(item['createdAt']));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('caps limit at the documented maximum', async () => {
    const fake = new FakeFoursquare({ checkins: makeCheckins(1) });
    await fetchCheckins(clientFor(fake), { limit: 5000, offset: 0 });
    expect(fake.requests[0]?.params['limit']).toBe('250');
  });

  it('tolerates a response with no checkins envelope at all', async () => {
    const empty: typeof fetch = async () =>
      new Response(JSON.stringify({ meta: { code: 200 }, response: {} }), { status: 200 });
    const client = new FoursquareClient({
      endpoint: API_ENDPOINT,
      apiVersion: '20250401',
      token: 't',
      logger: silent,
      fetchImpl: empty,
    });
    expect(await fetchCheckins(client, { limit: 10, offset: 0 })).toEqual({ count: 0, items: [] });
  });

  it('drops non-object items rather than passing them on', async () => {
    const junk: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          meta: { code: 200 },
          response: { checkins: { count: 3, items: [{ id: 'a' }, 'not an object', null] } },
        }),
        { status: 200 },
      );
    const client = new FoursquareClient({
      endpoint: API_ENDPOINT,
      apiVersion: '20250401',
      token: 't',
      logger: silent,
      fetchImpl: junk,
    });
    const page = await fetchCheckins(client, { limit: 10, offset: 0 });
    expect(page.items).toHaveLength(1);
  });
});

describe('probeCapabilities', () => {
  const probe = (supports: Partial<FakeSupport>, count = 10) =>
    probeCapabilities(
      clientFor(new FakeFoursquare({ checkins: makeCheckins(count), supports })),
      '20250401',
      silent,
    );

  it('detects all three when they work', async () => {
    const verdict = await probe({});
    expect(verdict).toMatchObject({
      afterTimestamp: true,
      beforeTimestamp: true,
      sortOldestFirst: true,
    });
  });

  it('detects all three when they are silently ignored', async () => {
    const verdict = await probe({
      afterTimestamp: false,
      beforeTimestamp: false,
      sortOldestFirst: false,
    });
    expect(verdict).toMatchObject({
      afterTimestamp: false,
      beforeTimestamp: false,
      sortOldestFirst: false,
    });
    expect(verdict.notes.join(' ')).toMatch(/None of the undocumented paging parameters/);
  });

  it.each([
    ['afterTimestamp'],
    ['beforeTimestamp'],
    ['sortOldestFirst'],
  ] as const)('isolates %s from the other two', async (parameter) => {
    const verdict = await probe({
      afterTimestamp: false,
      beforeTimestamp: false,
      sortOldestFirst: false,
      [parameter]: true,
    });
    expect(verdict[parameter]).toBe(true);
    for (const other of ['afterTimestamp', 'beforeTimestamp', 'sortOldestFirst'] as const) {
      if (other !== parameter) expect(verdict[other]).toBe(false);
    }
  });

  it('reports the account total, which the caller wants anyway', async () => {
    expect((await probe({}, 42)).remoteCount).toBe(42);
  });

  it('records the API version it ran under', async () => {
    expect((await probe({})).apiVersion).toBe('20250401');
  });

  it('refuses to guess on an account with fewer than two check-ins', async () => {
    const verdict = await probe({}, 1);
    expect(verdict.afterTimestamp).toBe(false);
    expect(verdict.notes.join(' ')).toMatch(/fewer than two check-ins/);
  });

  it('refuses to guess on an empty account', async () => {
    const verdict = await probe({}, 0);
    expect(verdict.notes.join(' ')).toMatch(/no check-ins/);
  });

  it('costs four requests and no more', async () => {
    const fake = new FakeFoursquare({ checkins: makeCheckins(10) });
    await probeCapabilities(clientFor(fake), '20250401', silent);
    expect(fake.requests).toHaveLength(4);
  });

  it('asks for one item at a time, so probing a huge account is still cheap', async () => {
    const fake = new FakeFoursquare({ checkins: makeCheckins(10) });
    await probeCapabilities(clientFor(fake), '20250401', silent);
    expect(fake.requests.every((request) => request.params['limit'] === '1')).toBe(true);
  });

  it('uses a boundary an inclusive afterTimestamp could not satisfy either', async () => {
    // Probing with the newest check-in's own timestamp would return that
    // check-in if the boundary is inclusive, and read as "ignored". One second
    // later is unambiguous under both readings.
    const checkins = makeCheckins(10);
    const newest = Math.max(...checkins.map((checkin) => Number(checkin['createdAt'])));
    const fake = new FakeFoursquare({ checkins });
    await probeCapabilities(clientFor(fake), '20250401', silent);

    const afterRequest = fake.requests.find((request) => 'afterTimestamp' in request.params);
    expect(Number(afterRequest?.params['afterTimestamp'])).toBe(newest + 1);
  });
});
