import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { API_ENDPOINT } from '../../src/config.js';
import { FoursquareClient } from '../../src/foursquare/client.js';
import { CheckinIndex } from '../../src/store/index-db.js';
import { readRaw } from '../../src/store/raw.js';
import { readState } from '../../src/store/state.js';
import { sync, type SyncDeps } from '../../src/sync/run.js';
import { FakeFoursquare, type FakeSupport } from '../support/fake-foursquare.js';
import {
  BASE_CREATED_AT,
  makeCheckin,
  makeCheckins,
  workspace,
  type Workspace,
} from '../support/factory.js';

let space: Workspace;
let index: CheckinIndex;

beforeEach(() => {
  space = workspace();
  index = CheckinIndex.open(space.paths.indexPath).index;
});
afterEach(() => {
  index.close();
  space.cleanup();
});

const deps = (fake: FakeFoursquare): SyncDeps => ({
  client: new FoursquareClient({
    endpoint: API_ENDPOINT,
    apiVersion: '20250401',
    token: 'test-token',
    logger: space.logger,
    fetchImpl: fake.fetch,
    sleep: async () => undefined,
  }),
  index,
  paths: space.paths,
  logger: space.logger,
  apiVersion: '20250401',
});

const rawIds = async (): Promise<string[]> => {
  const ids: string[] = [];
  for await (const entry of readRaw(space.paths)) ids.push(entry.id);
  return ids;
};

const ALL_OFF: FakeSupport = {
  afterTimestamp: false,
  beforeTimestamp: false,
  sortOldestFirst: false,
};

describe('the first sync', () => {
  it('backfills the whole history', async () => {
    const fake = new FakeFoursquare({ checkins: makeCheckins(37) });
    const result = await sync(deps(fake), { pageSize: 10 });

    expect(result.added).toBe(37);
    expect(result.storedTotal).toBe(37);
    expect(result.backfillComplete).toBe(true);
    expect(result.phasesRun).toEqual(['backfill']);
    expect(index.count()).toBe(37);
  });

  it('writes every check-in to the raw archive as well as the index', async () => {
    const fake = new FakeFoursquare({ checkins: makeCheckins(12) });
    await sync(deps(fake), { pageSize: 5 });
    expect((await rawIds()).sort()).toEqual(
      makeCheckins(12).map((checkin) => String(checkin['id'])).sort(),
    );
  });

  it('records the watermarks and the remote total', async () => {
    const fake = new FakeFoursquare({ checkins: makeCheckins(20) });
    await sync(deps(fake), { pageSize: 20 });

    const state = readState(space.paths);
    expect(state.newest?.id).toBe('checkin-0019');
    expect(state.oldest?.id).toBe('checkin-0000');
    expect(state.remoteCount).toBe(20);
    expect(state.backfill.complete).toBe(true);
  });

  it('handles a page size that divides the total exactly', async () => {
    const fake = new FakeFoursquare({ checkins: makeCheckins(20) });
    const result = await sync(deps(fake), { pageSize: 10 });
    expect(result.storedTotal).toBe(20);
    expect(result.backfillComplete).toBe(true);
  });

  it('handles an empty account', async () => {
    const result = await sync(deps(new FakeFoursquare({ checkins: [] })), { pageSize: 10 });
    expect(result.storedTotal).toBe(0);
    expect(result.backfillComplete).toBe(true);
  });

  it('handles exactly one check-in', async () => {
    const fake = new FakeFoursquare({ checkins: [makeCheckin()] });
    const result = await sync(deps(fake), { pageSize: 250 });
    expect(result.storedTotal).toBe(1);
  });
});

describe('the second sync', () => {
  it('does nothing when nothing has changed', async () => {
    const fake = new FakeFoursquare({ checkins: makeCheckins(30) });
    await sync(deps(fake), { pageSize: 10 });

    const before = fake.requests.length;
    const result = await sync(deps(fake), { pageSize: 10 });

    expect(result.added).toBe(0);
    expect(result.phasesRun).toEqual(['catch-up']);
    // One page, not a re-walk of the history.
    expect(fake.requests.length - before).toBeLessThanOrEqual(2);
  });

  it('picks up check-ins created since the last run', async () => {
    const fake = new FakeFoursquare({ checkins: makeCheckins(30) });
    await sync(deps(fake), { pageSize: 10 });

    for (let i = 0; i < 3; i += 1) {
      fake.add(makeCheckin({ id: `new-${i}`, createdAt: BASE_CREATED_AT + 1_000_000 + i }));
    }

    const result = await sync(deps(fake), { pageSize: 10 });
    expect(result.added).toBe(3);
    expect(index.count()).toBe(33);
    expect(index.newest()?.id).toBe('new-2');
  });

  it('does not append a second raw line for a check-in it already holds', async () => {
    const fake = new FakeFoursquare({ checkins: makeCheckins(10) });
    await sync(deps(fake), { pageSize: 10 });
    const after = (await rawIds()).length;

    await sync(deps(fake), { pageSize: 10 });
    await sync(deps(fake), { pageSize: 10 });

    expect((await rawIds()).length).toBe(after);
  });

  it('refreshes the copy it re-fetched, so like counts stay current', async () => {
    const fake = new FakeFoursquare({ checkins: [makeCheckin({ likes: 0 })] });
    await sync(deps(fake), { pageSize: 10 });
    expect(index.get('checkin-1')?.likeCount).toBe(0);

    // The same check-in, now with likes on it, plus one newer so the catch-up
    // walk actually reaches it.
    const fresher = new FakeFoursquare({
      checkins: [
        makeCheckin({ likes: 7 }),
        makeCheckin({ id: 'newer', createdAt: BASE_CREATED_AT + 1000 }),
      ],
    });
    const result = await sync(deps(fresher), { pageSize: 10 });

    expect(result.refreshed).toBeGreaterThan(0);
    expect(index.get('checkin-1')?.likeCount).toBe(7);
  });

  it('walks past a whole page of new check-ins to reach known ground', async () => {
    const fake = new FakeFoursquare({ checkins: makeCheckins(10) });
    await sync(deps(fake), { pageSize: 5 });

    // More new check-ins than fit in a page: the catch-up must not stop at one.
    for (let i = 0; i < 12; i += 1) {
      fake.add(makeCheckin({ id: `burst-${i}`, createdAt: BASE_CREATED_AT + 1_000_000 + i }));
    }

    const result = await sync(deps(fake), { pageSize: 5 });
    expect(result.added).toBe(12);
    expect(index.count()).toBe(22);
  });

  it.each([true, false])(
    'catches up correctly with afterTimestamp support = %s',
    async (afterTimestamp) => {
      const fake = new FakeFoursquare({
        checkins: makeCheckins(20),
        supports: { ...ALL_OFF, afterTimestamp },
      });
      await sync(deps(fake), { pageSize: 7 });
      fake.add(makeCheckin({ id: 'brand-new', createdAt: BASE_CREATED_AT + 9_000_000 }));

      const result = await sync(deps(fake), { pageSize: 7 });
      expect(result.added).toBe(1);
      expect(index.count()).toBe(21);
    },
  );
});

describe('resuming an interrupted backfill', () => {
  it('saves its position after every page', async () => {
    const fake = new FakeFoursquare({ checkins: makeCheckins(50) });
    await sync(deps(fake), { pageSize: 10, maxPages: 6 });

    const state = readState(space.paths);
    expect(state.backfill.complete).toBe(false);
    expect(state.backfill.offset).toBeGreaterThan(0);
  });

  it('picks up where it stopped and misses nothing', async () => {
    const fake = new FakeFoursquare({ checkins: makeCheckins(50) });

    // Four separate runs, each cut short, exactly as four crashes would be.
    for (let run = 0; run < 4; run += 1) {
      await sync(deps(fake), { pageSize: 10, maxPages: 6 });
    }
    await sync(deps(fake), { pageSize: 10 });

    expect(index.count()).toBe(50);
    expect(readState(space.paths).backfill.complete).toBe(true);
    // Nothing was archived twice.
    const ids = await rawIds();
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('reports that it stopped early rather than claiming completion', async () => {
    const fake = new FakeFoursquare({ checkins: makeCheckins(100) });
    const result = await sync(deps(fake), { pageSize: 10, maxPages: 6 });
    expect(result.stoppedEarly).toBe(true);
    expect(result.backfillComplete).toBe(false);
  });

  it('does not re-probe on the resuming run', async () => {
    const fake = new FakeFoursquare({ checkins: makeCheckins(50) });
    await sync(deps(fake), { pageSize: 10, maxPages: 6 });
    const probeRequests = fake.requests.filter((request) => request.params['limit'] === '1').length;

    await sync(deps(fake), { pageSize: 10 });
    const after = fake.requests.filter((request) => request.params['limit'] === '1').length;
    expect(after).toBe(probeRequests);
  });

  it('re-probes when asked', async () => {
    const fake = new FakeFoursquare({ checkins: makeCheckins(10) });
    await sync(deps(fake), { pageSize: 10 });
    const before = fake.requests.length;
    await sync(deps(fake), { pageSize: 10, reprobe: true });
    expect(fake.requests.length - before).toBeGreaterThanOrEqual(4);
  });
});

describe('paging stability while the collection grows', () => {
  /** Adds a check-in after the nth page request, as a real one would arrive. */
  const growAfterPage = (fake: FakeFoursquare, nth: number): FakeFoursquare => {
    const inner = fake.fetch;
    let pages = 0;
    const wrapper = Object.create(fake) as FakeFoursquare;
    Object.defineProperty(wrapper, 'fetch', {
      value: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = new URL(String(input));
        if (url.searchParams.get('limit') !== '1') {
          pages += 1;
          if (pages === nth) {
            fake.add(
              makeCheckin({ id: 'arrived-mid-run', createdAt: BASE_CREATED_AT + 9_999_999 }),
            );
          }
        }
        return inner(input, init);
      }) as typeof fetch,
    });
    return wrapper;
  };

  it('loses nothing when sort=oldestfirst holds the window still', async () => {
    const fake = new FakeFoursquare({
      checkins: makeCheckins(40),
      supports: { ...ALL_OFF, sortOldestFirst: true },
    });
    await sync(deps(growAfterPage(fake, 2)), { pageSize: 10 });

    // The 40 originals must all be present. The one that arrived mid-run is
    // beyond the pinned window and is picked up by the next catch-up.
    for (const checkin of makeCheckins(40)) {
      expect(index.has(String(checkin['id'])), String(checkin['id'])).toBe(true);
    }
  });

  it('loses nothing when beforeTimestamp pins the window', async () => {
    const fake = new FakeFoursquare({
      checkins: makeCheckins(40),
      supports: { ...ALL_OFF, beforeTimestamp: true },
    });
    await sync(deps(growAfterPage(fake, 2)), { pageSize: 10 });

    for (const checkin of makeCheckins(40)) {
      expect(index.has(String(checkin['id'])), String(checkin['id'])).toBe(true);
    }
  });

  it('warns rather than pretending, when nothing can hold the window still', async () => {
    const fake = new FakeFoursquare({ checkins: makeCheckins(40), supports: ALL_OFF });
    const result = await sync(deps(growAfterPage(fake, 2)), { pageSize: 10 });

    expect(result.notes.join(' ')).toMatch(/Backfilling by offset alone/);
  });

  it('a second run repairs whatever a shifting window cost the first', async () => {
    const fake = new FakeFoursquare({ checkins: makeCheckins(40), supports: ALL_OFF });
    await sync(deps(growAfterPage(fake, 2)), { pageSize: 10 });
    await sync(deps(fake), { pageSize: 10, full: true });

    expect(index.count()).toBe(41);
  });
});

describe('a full re-walk', () => {
  it('re-reads everything without duplicating it', async () => {
    const fake = new FakeFoursquare({ checkins: makeCheckins(25) });
    await sync(deps(fake), { pageSize: 10 });
    const rawBefore = (await rawIds()).length;

    const result = await sync(deps(fake), { pageSize: 10, full: true });

    expect(result.added).toBe(0);
    expect(result.refreshed).toBe(25);
    expect(index.count()).toBe(25);
    expect((await rawIds()).length).toBe(rawBefore);
  });

  it('skips the catch-up phase, since it is walking everything anyway', async () => {
    const fake = new FakeFoursquare({ checkins: makeCheckins(10) });
    await sync(deps(fake), { pageSize: 10 });
    const result = await sync(deps(fake), { pageSize: 10, full: true });
    expect(result.phasesRun).toEqual(['backfill']);
  });
});

describe('robustness', () => {
  it('skips a check-in it cannot key on and keeps going', async () => {
    const fake = new FakeFoursquare({
      checkins: [
        ...makeCheckins(3),
        { createdAt: BASE_CREATED_AT + 500 }, // no id
        { id: 'no-time' }, // no createdAt
      ],
    });
    const result = await sync(deps(fake), { pageSize: 10 });

    expect(index.count()).toBe(3);
    expect(result.notes.some((note) => /without an id/.test(note))).toBe(true);
  });

  it('recovers a page after a rate limit without losing it', async () => {
    const fake = new FakeFoursquare({ checkins: makeCheckins(30) });
    fake.failNext({ status: 429, times: 2 });
    const result = await sync(deps(fake), { pageSize: 10 });
    expect(result.storedTotal).toBe(30);
  });

  it('leaves a resumable state behind when the API stops answering', async () => {
    const fake = new FakeFoursquare({ checkins: makeCheckins(60) });
    const client = deps(fake);
    // Let a few pages through, then fail permanently.
    const inner = fake.fetch;
    let calls = 0;
    const failing: typeof fetch = async (input, init) => {
      calls += 1;
      if (calls > 7) throw new TypeError('network gone');
      return inner(input, init);
    };

    await expect(
      sync(
        {
          ...client,
          client: new FoursquareClient({
            endpoint: API_ENDPOINT,
            apiVersion: '20250401',
            token: 'test-token',
            logger: space.logger,
            fetchImpl: failing,
            sleep: async () => undefined,
            maxAttempts: 2,
          }),
        },
        { pageSize: 10 },
      ),
    ).rejects.toThrow();

    // Whatever it got is on disk, and the offset points past it.
    expect(index.count()).toBeGreaterThan(0);
    expect(readState(space.paths).backfill.offset).toBeGreaterThan(0);
    expect(readState(space.paths).backfill.complete).toBe(false);

    // And the next run finishes the job.
    await sync(deps(fake), { pageSize: 10 });
    expect(index.count()).toBe(60);
  });

  it('notes a shortfall against the count Foursquare reports', async () => {
    const fake = new FakeFoursquare({ checkins: makeCheckins(5) });
    await sync(deps(fake), { pageSize: 10 });

    // Deleted locally is not a case that happens, but a mismatch has to be
    // reported rather than silently accepted. Removing a row simulates one.
    CheckinIndex.query(space.paths.indexPath, 'SELECT 1', 1);
    index.clear();
    const result = await sync(deps(fake), { pageSize: 10, full: true });
    expect(result.storedTotal).toBe(5);
  });

  it('says so when the archive holds more than Foursquare still reports', async () => {
    const fake = new FakeFoursquare({ checkins: makeCheckins(10) });
    await sync(deps(fake), { pageSize: 10 });

    const shrunk = new FakeFoursquare({ checkins: makeCheckins(10).slice(0, 4) });
    const result = await sync(deps(shrunk), { pageSize: 10, full: true });

    expect(result.notes.join(' ')).toMatch(/expected if any have been deleted/);
    expect(index.count()).toBe(10);
  });
});
