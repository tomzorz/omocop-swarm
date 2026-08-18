import { describe, expect, it } from 'vitest';
import { compileFilter, orderBy } from '../../src/domain/query.js';
import { parseDate } from '../../src/domain/time.js';

describe('compileFilter', () => {
  it('is a no-op clause when nothing is filtered', () => {
    const compiled = compileFilter({});
    expect(compiled.where).toBe('1 = 1');
    expect(compiled.params).toEqual({});
    expect(compiled.applied).toEqual([]);
  });

  it('turns a single day into a half-open range', () => {
    const compiled = compileFilter({ from: '2019-06-12' });
    expect(compiled.where).toContain('local_ts >= @fromTs AND local_ts < @toTs');
    expect(compiled.params['fromTs']).toBe(parseDate('2019-06-12'));
    expect(compiled.params['toTs']).toBe(parseDate('2019-06-13'));
    expect(compiled.applied).toContain('on 2019-06-12');
  });

  it('applies the day-start shift to both edges', () => {
    const compiled = compileFilter({ from: '2019-06-12', dayStartHour: 6 });
    expect(compiled.params['fromTs']).toBe(parseDate('2019-06-12') + 6 * 3600);
    expect(compiled.params['toTs']).toBe(parseDate('2019-06-13') + 6 * 3600);
  });

  it('reads a bare `to` as everything up to that day', () => {
    const compiled = compileFilter({ to: '2019-06-12' });
    expect(compiled.where).toBe('local_ts < @toTs');
    expect(compiled.applied).toContain('up to 2019-06-12');
  });

  it('passes every value as a bound parameter, never inlined', () => {
    const compiled = compileFilter({
      venue: "O'Brien's",
      city: 'Budapest',
      venueId: 'venue-1',
    });
    expect(compiled.where).not.toContain("O'Brien");
    expect(compiled.where).not.toContain('Budapest');
    // Folded, because the column it is compared against is the folded one.
    expect(compiled.params['venue']).toBe("%o'brien's%");
  });

  it('escapes LIKE wildcards in the value, so a literal % stays literal', () => {
    const compiled = compileFilter({ venue: '100% Bagel_Shop' });
    expect(compiled.params['venue']).toBe('%100\\% bagel\\_shop%');
    expect(compiled.where).toContain("ESCAPE '\\'");
  });

  it('matches against the folded columns, with a folded value on both sides', () => {
    // SQLite's LIKE folds ASCII case and nothing else, so "kulturalis" would
    // never find "Kulturális" without pairing a folded column with a folded value.
    const compiled = compileFilter({ venue: 'KULTURÁLIS', city: 'Zürich' });
    expect(compiled.where).toContain('venue_name_fold LIKE');
    expect(compiled.where).toContain('city_fold LIKE');
    expect(compiled.params['venue']).toBe('%kulturalis%');
    expect(compiled.params['city']).toBe('%zurich%');
  });

  it('still reports the filter in the words the caller used, not the folded ones', () => {
    expect(compileFilter({ venue: 'Kulturális' }).applied).toContain(
      'venue containing "Kulturális"',
    );
  });

  it('escapes a backslash in the value too', () => {
    const compiled = compileFilter({ city: 'a\\b' });
    expect(compiled.params['city']).toBe('%a\\\\b%');
  });

  it('matches a two-letter country against the code and a longer one against the name', () => {
    const byCode = compileFilter({ country: 'hu' });
    expect(byCode.where).toContain('LOWER(country_code) = LOWER(@country)');
    expect(byCode.params['country']).toBe('hu');

    const byName = compileFilter({ country: 'Hungary' });
    expect(byName.where).toContain('country_fold LIKE');
    expect(byName.params['country']).toBe('%hungary%');
  });

  it('joins several filters with AND', () => {
    const compiled = compileFilter({ from: '2019-01-01', city: 'Berlin', withPhotos: true });
    expect(compiled.where.split(' AND ').length).toBeGreaterThanOrEqual(3);
    expect(compiled.applied).toHaveLength(3);
  });

  it('ignores the boolean narrowing flags when they are false', () => {
    const compiled = compileFilter({ withPhotos: false, withShout: false, withFriends: false });
    expect(compiled.where).toBe('1 = 1');
  });

  it('brackets the coordinate OR so it cannot swallow the clauses before it', () => {
    // Unbracketed, `city = x AND lat IS NULL OR lng IS NULL` parses as
    // `(city = x AND lat IS NULL) OR lng IS NULL` — every unplaceable check-in
    // anywhere would match a query scoped to one city.
    const compiled = compileFilter({ city: 'Budapest', hasCoordinates: false });
    expect(compiled.where).toContain('(lat IS NULL OR lng IS NULL)');
    expect(compiled.where).toMatch(/AND \(lat IS NULL OR lng IS NULL\)$/);
  });

  it('binds all four box edges', () => {
    const compiled = compileFilter({
      box: { minLat: 1, maxLat: 2, minLng: 3, maxLng: 4 },
    });
    expect(compiled.params).toMatchObject({ minLat: 1, maxLat: 2, minLng: 3, maxLng: 4 });
    expect(compiled.where).toContain('lat IS NOT NULL');
  });

  it('propagates a malformed date rather than producing a silently wrong range', () => {
    expect(() => compileFilter({ from: '2019-02-30' })).toThrow(/calendar date/);
  });
});

describe('orderBy', () => {
  it('breaks ties by id so paging cannot drop or repeat a row', () => {
    expect(orderBy('newest')).toBe('local_ts DESC, id DESC');
    expect(orderBy('oldest')).toBe('local_ts ASC, id ASC');
  });
});
