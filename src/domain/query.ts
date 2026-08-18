/**
 * Filters, compiled to SQL fragments.
 *
 * Pure on purpose: this file has no database handle and never executes
 * anything, so the mapping from a filter to a WHERE clause is table-testable
 * without a fixture archive. The store executes what it is handed.
 *
 * Every value travels as a named parameter. Not one filter concatenates a
 * caller's string into SQL — including the LIKE patterns, where the `%` is
 * added to the *parameter* rather than to the statement.
 */
import type { BoundingBox } from './geo.js';
import { dayWindow } from './time.js';
import { fold } from './text.js';

export interface CheckinFilter {
  /** First day, `YYYY-MM-DD`, in venue-local time. */
  readonly from?: string;
  /** Last day, inclusive. Defaults to `from` when only `from` is given. */
  readonly to?: string;
  /** Hour the day starts at. See domain/time.ts. */
  readonly dayStartHour?: number;
  /** Substring of the venue name, case-insensitive. */
  readonly venue?: string;
  /** Exact venue id, for following up on a result. */
  readonly venueId?: string;
  /** Substring of the primary category name, case-insensitive. */
  readonly category?: string;
  readonly city?: string;
  /** Country name or two-letter code. */
  readonly country?: string;
  readonly withPhotos?: boolean;
  readonly withShout?: boolean;
  readonly withFriends?: boolean;
  /**
   * True keeps only check-ins that have coordinates, false only those that do
   * not. A venue can be archived without a position — a deleted venue comes
   * back as a name and nothing else — and those are invisible to every
   * geographic query, so being able to count them is what stops "no results"
   * from being mistaken for "you were never there".
   */
  readonly hasCoordinates?: boolean;
  readonly box?: BoundingBox;
}

export interface Compiled {
  /** A WHERE body, without the keyword. `1 = 1` when nothing was filtered. */
  readonly where: string;
  readonly params: Record<string, unknown>;
  /** Human-readable account of what was applied, for the rendered output. */
  readonly applied: readonly string[];
}

/**
 * LIKE with no ESCAPE clause treats `%` and `_` in the *value* as wildcards, so
 * a search for `100%` silently matches everything. Escaping them and declaring
 * the escape character makes a literal search literal.
 *
 * The value is folded on the way in, and every column it is compared against is
 * a folded column, so case and accents stop mattering on both sides at once.
 */
const likeValue = (value: string): string =>
  `%${fold(value).replace(/[\\%_]/g, (character) => `\\${character}`)}%`;

const LIKE = "LIKE @PARAM ESCAPE '\\'";

export function compileFilter(filter: CheckinFilter): Compiled {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  const applied: string[] = [];

  const like = (column: string, key: string, value: string, label: string): void => {
    clauses.push(`${column} ${LIKE.replace('@PARAM', `@${key}`)}`);
    params[key] = likeValue(value);
    applied.push(`${label} containing "${value}"`);
  };

  if (filter.from !== undefined) {
    const window = dayWindow(filter.from, filter.to ?? filter.from, filter.dayStartHour ?? 0);
    clauses.push('local_ts >= @fromTs AND local_ts < @toTs');
    params['fromTs'] = window.from;
    params['toTs'] = window.to;
    applied.push(
      filter.to && filter.to !== filter.from
        ? `${filter.from} to ${filter.to}`
        : `on ${filter.from}`,
    );
  } else if (filter.to !== undefined) {
    // `to` without `from` reads as "everything up to and including this day".
    const window = dayWindow(filter.to, filter.to, filter.dayStartHour ?? 0);
    clauses.push('local_ts < @toTs');
    params['toTs'] = window.to;
    applied.push(`up to ${filter.to}`);
  }

  if (filter.venueId !== undefined) {
    clauses.push('venue_id = @venueId');
    params['venueId'] = filter.venueId;
    applied.push(`venue id ${filter.venueId}`);
  }
  if (filter.venue !== undefined) like('venue_name_fold', 'venue', filter.venue, 'venue');
  if (filter.category !== undefined) {
    like('category_name_fold', 'category', filter.category, 'category');
  }
  if (filter.city !== undefined) like('city_fold', 'city', filter.city, 'city');

  if (filter.country !== undefined) {
    // Two characters is a country code; anything longer is a name. Matching
    // both columns unconditionally would make "Chad" match every row in the
    // Republic of Chad and every row whose code happens to be CH.
    if (filter.country.length === 2) {
      clauses.push('LOWER(country_code) = LOWER(@country)');
      params['country'] = filter.country;
      applied.push(`country code ${filter.country.toUpperCase()}`);
    } else {
      like('country_fold', 'country', filter.country, 'country');
    }
  }

  if (filter.withPhotos === true) {
    clauses.push('photo_count > 0');
    applied.push('with photos');
  }
  if (filter.withShout === true) {
    clauses.push("shout IS NOT NULL AND shout <> ''");
    applied.push('with a shout');
  }
  if (filter.withFriends === true) {
    clauses.push('with_count > 0');
    applied.push('with friends');
  }

  if (filter.hasCoordinates !== undefined) {
    // Parenthesised because the clauses are joined with AND, and an unbracketed
    // OR would bind looser than every filter before it — turning "in Berlin and
    // unplaceable" into "in Berlin, or unplaceable anywhere".
    clauses.push(
      filter.hasCoordinates
        ? '(lat IS NOT NULL AND lng IS NOT NULL)'
        : '(lat IS NULL OR lng IS NULL)',
    );
    applied.push(filter.hasCoordinates ? 'with coordinates' : 'without coordinates');
  }

  if (filter.box) {
    clauses.push(
      'lat IS NOT NULL AND lng IS NOT NULL AND ' +
        'lat BETWEEN @minLat AND @maxLat AND lng BETWEEN @minLng AND @maxLng',
    );
    params['minLat'] = filter.box.minLat;
    params['maxLat'] = filter.box.maxLat;
    params['minLng'] = filter.box.minLng;
    params['maxLng'] = filter.box.maxLng;
    applied.push('within the search area');
  }

  return {
    where: clauses.length > 0 ? clauses.join(' AND ') : '1 = 1',
    params,
    applied,
  };
}

export const SORT_ORDERS = ['newest', 'oldest'] as const;
export type SortOrder = (typeof SORT_ORDERS)[number];

/**
 * ORDER BY for a listing.
 *
 * `id` breaks ties. Two check-ins can share a second — a bulk import, or a fast
 * double check-in — and without a tiebreak SQLite is free to return them in
 * either order, which makes paging drop and repeat rows at the boundary.
 */
export const orderBy = (sort: SortOrder): string =>
  sort === 'oldest' ? 'local_ts ASC, id ASC' : 'local_ts DESC, id DESC';
