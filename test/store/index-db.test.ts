import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normaliseCheckin } from '../../src/domain/checkin.js';
import { boundingBox } from '../../src/domain/geo.js';
import { CheckinIndex, ftsQuery, type Indexable } from '../../src/store/index-db.js';
import { BASE_CREATED_AT, makeCheckin, workspace, type Workspace } from '../support/factory.js';

let space: Workspace;
let index: CheckinIndex;

const indexable = (raw: Record<string, unknown>): Indexable => ({
  normalised: normaliseCheckin(raw),
  rawJson: JSON.stringify(raw),
});

const put = (...raws: Array<Record<string, unknown>>): number =>
  index.upsert(raws.map(indexable));

beforeEach(() => {
  space = workspace();
  index = CheckinIndex.open(space.paths.indexPath).index;
});
afterEach(() => {
  index.close();
  space.cleanup();
});

describe('upsert', () => {
  it('stores a check-in and its child rows', () => {
    put(makeCheckin({ photos: 2, friends: 3, shout: 'hello' }));
    expect(index.count()).toBe(1);

    const detail = index.get('checkin-1');
    expect(detail?.venueName).toBe('Kisüzem');
    expect(detail?.photos).toHaveLength(2);
    expect(detail?.companions).toHaveLength(3);
    expect(detail?.categories.map((category) => category.name)).toEqual(['Bar', 'Pub']);
  });

  it('replaces on re-insert, so refreshed counts win', () => {
    put(makeCheckin({ likes: 1, photos: 1 }));
    put(makeCheckin({ likes: 9, photos: 3 }));

    expect(index.count()).toBe(1);
    const detail = index.get('checkin-1');
    expect(detail?.likeCount).toBe(9);
    // The child rows are replaced too, not accumulated.
    expect(detail?.photos).toHaveLength(3);
  });

  it('does not accumulate duplicate category or companion rows on re-insert', () => {
    put(makeCheckin({ friends: 2 }));
    put(makeCheckin({ friends: 2 }));
    expect(index.get('checkin-1')?.companions).toHaveLength(2);
    expect(index.get('checkin-1')?.categories).toHaveLength(2);
  });

  it('accepts a check-in with every optional field missing', () => {
    expect(() => put({ id: 'bare', createdAt: BASE_CREATED_AT })).not.toThrow();
    expect(index.get('bare')?.venueName).toBeNull();
  });

  it('is a no-op for an empty batch', () => {
    expect(index.upsert([])).toBe(0);
  });

  it('reports which ids it already holds, in one query', () => {
    put(makeCheckin({ id: 'a' }), makeCheckin({ id: 'b' }));
    const known = index.known(['a', 'c', 'b']);
    expect([...known].sort()).toEqual(['a', 'b']);
    expect(index.known([]).size).toBe(0);
  });

  it('keeps the raw JSON retrievable', () => {
    const raw = makeCheckin();
    raw['unmodelledField'] = { deep: [1, 2, 3] };
    put(raw);
    expect(index.get('checkin-1')?.raw).toMatchObject({ unmodelledField: { deep: [1, 2, 3] } });
  });
});

describe('watermarks', () => {
  it('are undefined on an empty index', () => {
    expect(index.newest()).toBeUndefined();
    expect(index.oldest()).toBeUndefined();
  });

  it('report the extremes by creation time', () => {
    put(
      makeCheckin({ id: 'middle', createdAt: BASE_CREATED_AT }),
      makeCheckin({ id: 'old', createdAt: BASE_CREATED_AT - 10_000 }),
      makeCheckin({ id: 'new', createdAt: BASE_CREATED_AT + 10_000 }),
    );
    expect(index.newest()?.id).toBe('new');
    expect(index.oldest()?.id).toBe('old');
  });
});

describe('list', () => {
  beforeEach(() => {
    put(
      makeCheckin({ id: 'a', createdAt: BASE_CREATED_AT, city: 'Budapest', cc: 'HU' }),
      makeCheckin({
        id: 'b',
        createdAt: BASE_CREATED_AT + 86_400,
        city: 'Berlin',
        cc: 'DE',
        country: 'Germany',
        venueName: 'Bar Zebra',
        photos: 2,
      }),
      makeCheckin({ id: 'c', createdAt: BASE_CREATED_AT + 172_800, shout: 'third one' }),
    );
  });

  it('returns everything, newest first, by default', () => {
    const result = index.list({}, 'newest', 10);
    expect(result.total).toBe(3);
    expect(result.items.map((item) => item.id)).toEqual(['c', 'b', 'a']);
  });

  it('reverses on request', () => {
    expect(index.list({}, 'oldest', 10).items.map((item) => item.id)).toEqual(['a', 'b', 'c']);
  });

  it('filters to a single local day', () => {
    const result = index.list({ from: '2019-06-12' }, 'newest', 10);
    expect(result.items.map((item) => item.id)).toEqual(['a']);
    expect(result.applied).toContain('on 2019-06-12');
  });

  it('filters to a range', () => {
    expect(index.list({ from: '2019-06-12', to: '2019-06-13' }, 'newest', 10).total).toBe(2);
  });

  it('filters by city, country code and country name', () => {
    expect(index.list({ city: 'berlin' }, 'newest', 10).total).toBe(1);
    expect(index.list({ country: 'DE' }, 'newest', 10).total).toBe(1);
    expect(index.list({ country: 'Germany' }, 'newest', 10).total).toBe(1);
    expect(index.list({ country: 'HU' }, 'newest', 10).total).toBe(2);
  });

  it('filters by photos, shouts and company', () => {
    expect(index.list({ withPhotos: true }, 'newest', 10).total).toBe(1);
    expect(index.list({ withShout: true }, 'newest', 10).total).toBe(1);
    expect(index.list({ withFriends: true }, 'newest', 10).total).toBe(0);
  });

  it('reports the total before the limit, so paging knows there is more', () => {
    const result = index.list({}, 'newest', 2, 0);
    expect(result.items).toHaveLength(2);
    expect(result.total).toBe(3);
  });

  it('pages without repeating or dropping rows', () => {
    const first = index.list({}, 'newest', 2, 0).items.map((item) => item.id);
    const second = index.list({}, 'newest', 2, 2).items.map((item) => item.id);
    expect([...first, ...second]).toEqual(['c', 'b', 'a']);
  });

  it('separates check-ins with and without coordinates', () => {
    put({ id: 'unplaceable', createdAt: BASE_CREATED_AT, venue: { name: 'Nowhere' } });
    expect(index.list({ hasCoordinates: false }, 'newest', 10).total).toBe(1);
    expect(index.list({ hasCoordinates: true }, 'newest', 10).total).toBe(3);
  });

  it('does not let the coordinate OR escape the other filters', () => {
    put({ id: 'unplaceable', createdAt: BASE_CREATED_AT, venue: { name: 'Nowhere' } });
    // Berlin has no unplaceable check-in; without the brackets this returns one.
    expect(index.list({ city: 'Berlin', hasCoordinates: false }, 'newest', 10).total).toBe(0);
  });
});

describe('get', () => {
  it('returns undefined for an unknown id', () => {
    expect(index.get('nope')).toBeUndefined();
  });

  it('reassembles photo URLs from the stored halves', () => {
    put(makeCheckin({ photos: 1 }));
    expect(index.get('checkin-1')?.photos[0]?.url).toBe(
      'https://fastly.4sqi.net/img/general/original/12345_photo0.jpg',
    );
  });
});

describe('summary and grouping', () => {
  beforeEach(() => {
    put(
      makeCheckin({ id: 'a', venueId: 'v1', venueName: 'Kisüzem', createdAt: BASE_CREATED_AT }),
      makeCheckin({
        id: 'b',
        venueId: 'v1',
        venueName: 'Kisüzem',
        createdAt: BASE_CREATED_AT + 86_400,
      }),
      makeCheckin({
        id: 'c',
        venueId: 'v2',
        venueName: 'Szimpla',
        city: 'Berlin',
        cc: 'DE',
        category: 'Cafe',
        createdAt: BASE_CREATED_AT + 172_800,
        photos: 1,
      }),
    );
  });

  it('summarises totals and distinct counts', () => {
    const summary = index.summary();
    expect(summary.total).toBe(3);
    expect(summary.venues).toBe(2);
    expect(summary.cities).toBe(2);
    expect(summary.countries).toBe(2);
    expect(summary.withPhotos).toBe(1);
    expect(summary.firstCheckin).toBe('2019-06-12');
    expect(summary.lastCheckin).toBe('2019-06-14');
  });

  it('summarises a filtered slice', () => {
    expect(index.summary({ city: 'Berlin' }).total).toBe(1);
  });

  it('is safe on an empty result', () => {
    const summary = index.summary({ city: 'Nowhere' });
    expect(summary.total).toBe(0);
    expect(summary.firstCheckin).toBeNull();
  });

  it('ranks venues by visit count with first and last dates', () => {
    const venues = index.venues({}, 'visits', 10).items;
    expect(venues[0]).toMatchObject({ label: 'Kisüzem', count: 2, first: '2019-06-12', last: '2019-06-13' });
    expect(venues[1]?.count).toBe(1);
  });

  it('orders venues four ways, and reports the distinct total', () => {
    const by = (sort: 'visits' | 'recent' | 'first' | 'name') =>
      index.venues({}, sort, 10).items.map((venue) => venue.label);

    // Kisüzem visited twice (06-12, 06-13), Szimpla once (06-14).
    expect(by('visits')).toEqual(['Kisüzem', 'Szimpla']);
    expect(by('recent')).toEqual(['Szimpla', 'Kisüzem']);
    expect(by('first')).toEqual(['Kisüzem', 'Szimpla']);
    expect(by('name')).toEqual(['Kisüzem', 'Szimpla']);
    expect(index.venues({}, 'visits', 10).total).toBe(2);
  });

  it('carries enough context to recognise a venue without a second lookup', () => {
    const venue = index.venues({ venue: 'szimpla' }, 'visits', 10).items[0];
    expect(venue).toMatchObject({ category: 'Cafe', city: 'Berlin', countryCode: 'DE' });
  });

  it('counts distinct venues, not check-ins, in the total', () => {
    expect(index.venues({}, 'visits', 1).items).toHaveLength(1);
    expect(index.venues({}, 'visits', 1).total).toBe(2);
  });

  it('groups by a chosen dimension', () => {
    expect(index.groupBy('city', {}, 10).map((group) => group.label).sort()).toEqual([
      'Berlin',
      'Budapest',
    ]);
    expect(index.groupBy('category_name', {}, 10).find((group) => group.label === 'Cafe')?.count).toBe(1);
  });

  it('reports weekday and hour rhythms as fixed-length arrays', () => {
    const rhythm = index.rhythm({});
    expect(rhythm.weekday).toHaveLength(7);
    expect(rhythm.hour).toHaveLength(24);
    expect(rhythm.hour[21]).toBe(3);
    expect(rhythm.hour.reduce((sum, count) => sum + count, 0)).toBe(3);
  });
});

describe('search', () => {
  beforeEach(() => {
    put(
      makeCheckin({ id: 'a', shout: 'best langos in town', venueName: 'Retro Bufe' }),
      makeCheckin({ id: 'b', shout: 'quiet coffee', venueName: 'Espresso Embassy', category: 'Cafe' }),
      makeCheckin({ id: 'c', city: 'Berlin', venueName: 'Bar Zebra' }),
    );
  });

  it('finds by a word in a shout', () => {
    expect(index.search('langos', {}, 10).items.map((item) => item.id)).toEqual(['a']);
  });

  it('finds by venue name and by city', () => {
    expect(index.search('Espresso', {}, 10).total).toBe(1);
    expect(index.search('Berlin', {}, 10).total).toBe(1);
  });

  it('ANDs several words', () => {
    expect(index.search('quiet coffee', {}, 10).total).toBe(1);
    expect(index.search('quiet langos', {}, 10).total).toBe(0);
  });

  it('supports a trailing star as a prefix search', () => {
    expect(index.search('espr*', {}, 10).total).toBe(1);
  });

  it('narrows a search with the ordinary filters', () => {
    // "Bar" matches 'a' by its category and 'c' by its venue name.
    expect(index.search('Bar', {}, 10).total).toBe(2);
    expect(index.search('Bar', { city: 'Berlin' }, 10).items.map((item) => item.id)).toEqual(['c']);
    expect(index.search('Bar', { city: 'Budapest' }, 10).items.map((item) => item.id)).toEqual(['a']);
  });

  it('does not throw on FTS5 operators in the input', () => {
    for (const nasty of ['"', 'a OR b', '-nope', 'NEAR(', '*', '^', 'a AND', 'x:y']) {
      expect(() => index.search(nasty, {}, 10), nasty).not.toThrow();
    }
  });

  it('returns nothing for a search with no searchable words', () => {
    const result = index.search('   ***  ', {}, 10);
    expect(result.query).toBe('');
    expect(result.items).toEqual([]);
  });
});

describe('geography', () => {
  it('finds check-ins inside a bounding box and excludes those outside', () => {
    put(
      makeCheckin({ id: 'here', lat: 47.4979, lng: 19.0602 }),
      makeCheckin({ id: 'far', lat: 48.2082, lng: 16.3738 }),
    );
    const box = boundingBox({ lat: 47.4979, lng: 19.0602 }, 1_000);
    expect(index.list({ box }, 'newest', 10).items.map((item) => item.id)).toEqual(['here']);
  });

  it('excludes check-ins without coordinates from a box query', () => {
    put({ id: 'nowhere', createdAt: BASE_CREATED_AT, venue: { name: 'Gone' } });
    const box = boundingBox({ lat: 0, lng: 0 }, 20_000_000);
    expect(index.list({ box }, 'newest', 10).total).toBe(0);
  });
});

describe('schema versioning', () => {
  it('recreates the tables and reports it when the version on disk differs', () => {
    put(makeCheckin());
    expect(index.count()).toBe(1);
    index.close();

    // Simulate a database written by a different schema version.
    const raw = new Database(space.paths.indexPath);
    raw.pragma('user_version = 999');
    raw.close();

    const reopened = CheckinIndex.open(space.paths.indexPath);
    index = reopened.index;
    expect(reopened.rebuildRequired).toBe(true);
    expect(index.count()).toBe(0);
  });

  it('leaves an index at the current version alone', () => {
    put(makeCheckin());
    index.close();
    const reopened = CheckinIndex.open(space.paths.indexPath);
    index = reopened.index;
    expect(reopened.rebuildRequired).toBe(false);
    expect(index.count()).toBe(1);
  });
});

describe('accent and case folding', () => {
  beforeEach(() => {
    put(
      makeCheckin({ id: 'a', venueName: 'Koreai Kulturális Központ', city: 'Budapest' }),
      makeCheckin({ id: 'b', venueName: 'Café Zürich', city: 'Zürich', country: 'Switzerland' }),
      makeCheckin({ id: 'c', venueName: 'Plain Old Bar', city: 'Malmö', country: 'Sweden' }),
    );
  });

  it.each(['kulturalis', 'Kulturális', 'KULTURÁLIS', 'kUlTuRaLiS'])(
    'finds an accented venue when searched as %s',
    (typed) => {
      expect(index.list({ venue: typed }, 'newest', 10).items.map((item) => item.id)).toEqual(['a']);
    },
  );

  it.each(['zurich', 'Zürich', 'ZÜRICH'])('finds an accented city searched as %s', (typed) => {
    expect(index.list({ city: typed }, 'newest', 10).total).toBe(1);
  });

  it('folds the country name too', () => {
    expect(index.list({ country: 'sweden' }, 'newest', 10).total).toBe(1);
  });

  it('still matches plain ASCII, which must not regress', () => {
    expect(index.list({ venue: 'plain old' }, 'newest', 10).total).toBe(1);
    expect(index.list({ city: 'BUDAPEST' }, 'newest', 10).total).toBe(1);
  });

  it('does not match something merely similar', () => {
    expect(index.list({ venue: 'kulturxlis' }, 'newest', 10).total).toBe(0);
  });

  it('keeps LIKE wildcards in the value literal after folding', () => {
    put(makeCheckin({ id: 'pct', venueName: '100% Bagel' }));
    expect(index.list({ venue: '100%' }, 'newest', 10).items.map((i) => i.id)).toEqual(['pct']);
    expect(index.list({ venue: '%' }, 'newest', 10).total).toBe(1);
  });
});

describe('vocabulary lookup', () => {
  beforeEach(() => {
    put(
      makeCheckin({ id: 'a', venueName: 'Chatime', category: 'Bubble Tea Shop', city: 'Budapest' }),
      makeCheckin({ id: 'b', venueName: 'Bobapop', category: 'Bubble Tea Shop', city: 'Budapest' }),
      makeCheckin({ id: 'c', venueName: 'Gare du Nord', category: 'Rail Station', city: 'Paris', country: 'France', cc: 'FR' }),
    );
  });

  it('turns a fragment into the exact stored category', () => {
    const found = index.vocabulary('bubble', 10);
    expect(found.categories.map((match) => match.label)).toEqual(['Bubble Tea Shop']);
    expect(found.categories[0]?.count).toBe(2);
  });

  it('finds cities and countries by fragment', () => {
    expect(index.vocabulary('par', 10).cities.map((m) => m.label)).toEqual(['Paris']);
    expect(index.vocabulary('fran', 10).countries.map((m) => m.label)).toEqual(['France']);
  });

  it('finds venues by fragment', () => {
    expect(index.vocabulary('chat', 10).venues.map((m) => m.label)).toEqual(['Chatime']);
  });

  it('ignores case and accents', () => {
    put(makeCheckin({ id: 'd', venueName: 'Kulturális Központ' }));
    expect(index.vocabulary('KULTURALIS', 10).venues.map((m) => m.label)).toEqual([
      'Kulturális Központ',
    ]);
  });

  it('returns empty lists rather than failing when nothing matches', () => {
    const found = index.vocabulary('zzzznope', 10);
    expect(found.venues).toEqual([]);
    expect(found.categories).toEqual([]);
    expect(found.cities).toEqual([]);
    expect(found.countries).toEqual([]);
  });

  it('does not let a wildcard in the fragment match everything', () => {
    expect(index.vocabulary('%', 10).venues).toEqual([]);
  });

  it('honours the per-kind limit', () => {
    expect(index.vocabulary('a', 1).venues.length).toBeLessThanOrEqual(1);
  });
});

describe('the read-only query hatch', () => {
  beforeEach(() => {
    put(makeCheckin({ id: 'a' }), makeCheckin({ id: 'b' }));
  });

  it('runs a SELECT and returns rows', () => {
    const result = CheckinIndex.query(space.paths.indexPath, 'SELECT id FROM checkins ORDER BY id', 10);
    expect(result.rows).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('truncates at the limit and says so', () => {
    const result = CheckinIndex.query(space.paths.indexPath, 'SELECT id FROM checkins', 1);
    expect(result.rows).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it('refuses a statement that returns no rows', () => {
    expect(() =>
      CheckinIndex.query(space.paths.indexPath, "UPDATE checkins SET shout = 'hacked'", 10),
    ).toThrow(/does not return rows/);
  });

  it('is genuinely read-only, not merely pattern-checked', () => {
    // A write dressed up as a row-returning statement gets past any keyword
    // check. SQLite's read-only mode is what actually stops it.
    expect(() =>
      CheckinIndex.query(
        space.paths.indexPath,
        "DELETE FROM checkins WHERE id = 'a' RETURNING id",
        10,
      ),
    ).toThrow();
    expect(index.count()).toBe(2);
  });

  it('rejects invalid SQL rather than returning nothing', () => {
    expect(() => CheckinIndex.query(space.paths.indexPath, 'SELECT FROM nowhere', 10)).toThrow();
  });

  it('lists the tables and columns', () => {
    const schema = CheckinIndex.schema(space.paths.indexPath);
    const checkins = schema.find((entry) => entry.table === 'checkins');
    expect(checkins?.columns).toContain('local_ts');
    expect(checkins?.columns).toContain('venue_name');
    expect(schema.map((entry) => entry.table)).toContain('checkin_photos');
  });
});

describe('ftsQuery', () => {
  it.each([
    ['langos', '"langos"'],
    ['quiet coffee', '"quiet" AND "coffee"'],
    ['espr*', '"espr"*'],
    ['a "quoted" thing', '"a" AND "quoted" AND "thing"'],
    ['  spaced   out  ', '"spaced" AND "out"'],
    ['', ''],
    ['***', ''],
  ])('turns %j into %j', (input, expected) => {
    expect(ftsQuery(input)).toBe(expected);
  });
});
