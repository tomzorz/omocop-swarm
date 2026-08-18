/**
 * The SQLite index.
 *
 * Derived, entirely. Every row here is reconstructible from the raw JSONL, and
 * that is what licenses the decisions in this file: the schema can change
 * without a migration script (bump the version, re-index), a corrupt database
 * is a `reindex` away from fixed, and columns exist because a query wants them
 * rather than because the API happened to send them.
 *
 * The raw JSON is stored here *as well*, in a column. That is a deliberate
 * duplication: it makes "show me this check-in in full" a single lookup instead
 * of a scan through monthly files, and it costs a few tens of megabytes across
 * a decade. The JSONL remains the truth; this copy is a cache like the rest of
 * the table.
 */
import Database from 'better-sqlite3';
import type { NormalisedCheckin } from '../domain/checkin.js';
import { searchableText } from '../domain/checkin.js';
import { compileFilter, orderBy, type CheckinFilter, type SortOrder } from '../domain/query.js';
import { fold, foldOrNull } from '../domain/text.js';

/**
 * Bump when the schema changes. The index is then rebuilt from the JSONL rather
 * than migrated — there is no state here worth writing a migration for.
 */
export const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS checkins (
  id            TEXT PRIMARY KEY,
  created_at    INTEGER NOT NULL,
  tz_offset     INTEGER NOT NULL,
  local_ts      INTEGER NOT NULL,
  local_date    TEXT    NOT NULL,
  local_time    TEXT    NOT NULL,
  weekday       INTEGER NOT NULL,
  type          TEXT,
  shout         TEXT,
  venue_id      TEXT,
  venue_name    TEXT,
  lat           REAL,
  lng           REAL,
  address       TEXT,
  city          TEXT,
  state         TEXT,
  country       TEXT,
  country_code  TEXT,
  postal_code   TEXT,
  category_id   TEXT,
  category_name TEXT,
  photo_count   INTEGER NOT NULL DEFAULT 0,
  like_count    INTEGER NOT NULL DEFAULT 0,
  comment_count INTEGER NOT NULL DEFAULT 0,
  post_count    INTEGER NOT NULL DEFAULT 0,
  with_count    INTEGER NOT NULL DEFAULT 0,
  is_mayor      INTEGER NOT NULL DEFAULT 0,
  is_private    INTEGER NOT NULL DEFAULT 0,
  visibility    TEXT,
  source_name   TEXT,
  sticker_name  TEXT,
  event_name    TEXT,
  raw           TEXT    NOT NULL,

  -- Case-folded, accent-stripped copies of the columns people search by. See
  -- domain/text.ts: SQLite's LIKE folds ASCII case and nothing else, so without
  -- these "kulturalis" does not find "Kulturális" and neither does "KULTURÁLIS".
  -- They are matched against, never displayed.
  venue_name_fold    TEXT,
  city_fold          TEXT,
  country_fold       TEXT,
  category_name_fold TEXT
);

CREATE INDEX IF NOT EXISTS checkins_local_ts  ON checkins (local_ts);
CREATE INDEX IF NOT EXISTS checkins_venue     ON checkins (venue_id);
CREATE INDEX IF NOT EXISTS checkins_category  ON checkins (category_name);
CREATE INDEX IF NOT EXISTS checkins_city      ON checkins (city);
CREATE INDEX IF NOT EXISTS checkins_country   ON checkins (country_code);
CREATE INDEX IF NOT EXISTS checkins_position  ON checkins (lat, lng);

-- These serve the exact-match half of the folded lookups (grouping, and the
-- distinct-value scans behind find-filters). A LIKE with a leading wildcard
-- cannot use an index at all, in any of these columns, folded or not — at a few
-- thousand check-ins that costs microseconds, and pretending otherwise would be
-- the only dishonest thing in this schema.
CREATE INDEX IF NOT EXISTS checkins_venue_fold    ON checkins (venue_name_fold);
CREATE INDEX IF NOT EXISTS checkins_city_fold     ON checkins (city_fold);
CREATE INDEX IF NOT EXISTS checkins_country_fold  ON checkins (country_fold);
CREATE INDEX IF NOT EXISTS checkins_category_fold ON checkins (category_name_fold);

CREATE TABLE IF NOT EXISTS checkin_photos (
  checkin_id TEXT NOT NULL,
  photo_id   TEXT NOT NULL,
  prefix     TEXT,
  suffix     TEXT,
  width      INTEGER,
  height     INTEGER,
  created_at INTEGER,
  PRIMARY KEY (checkin_id, photo_id)
);

CREATE TABLE IF NOT EXISTS checkin_categories (
  checkin_id  TEXT NOT NULL,
  category_id TEXT,
  name        TEXT,
  plural_name TEXT,
  is_primary  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS checkin_categories_name ON checkin_categories (name);
CREATE INDEX IF NOT EXISTS checkin_categories_of   ON checkin_categories (checkin_id);

CREATE TABLE IF NOT EXISTS checkin_companions (
  checkin_id TEXT NOT NULL,
  user_id    TEXT,
  first_name TEXT,
  last_name  TEXT
);
CREATE INDEX IF NOT EXISTS checkin_companions_of   ON checkin_companions (checkin_id);
CREATE INDEX IF NOT EXISTS checkin_companions_user ON checkin_companions (user_id);

CREATE VIRTUAL TABLE IF NOT EXISTS checkins_fts USING fts5(checkin_id UNINDEXED, text);
`;

/** A check-in as the store hands it out. Camel-cased; no raw JSON. */
export interface StoredCheckin {
  readonly id: string;
  readonly createdAt: number;
  readonly createdAtUtc: string;
  readonly tzOffset: number;
  readonly localDate: string;
  readonly localTime: string;
  readonly weekday: number;
  readonly shout: string | null;
  readonly venueId: string | null;
  readonly venueName: string | null;
  readonly lat: number | null;
  readonly lng: number | null;
  readonly address: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly country: string | null;
  readonly countryCode: string | null;
  readonly categoryName: string | null;
  readonly photoCount: number;
  readonly likeCount: number;
  readonly commentCount: number;
  readonly withCount: number;
  readonly isMayor: boolean;
  readonly isPrivate: boolean;
  readonly sourceName: string | null;
  readonly stickerName: string | null;
  readonly eventName: string | null;
}

/** Columns a listing selects. `raw` is deliberately absent. */
const LIST_COLUMNS = `
  id, created_at, tz_offset, local_ts, local_date, local_time, weekday, shout,
  venue_id, venue_name, lat, lng, address, city, state, country, country_code,
  category_name, photo_count, like_count, comment_count, with_count,
  is_mayor, is_private, source_name, sticker_name, event_name
`;

type Row = Record<string, unknown>;

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const num = (value: unknown): number => (typeof value === 'number' ? value : 0);
const optNum = (value: unknown): number | null => (typeof value === 'number' ? value : null);

function toStored(row: Row): StoredCheckin {
  const createdAt = num(row['created_at']);
  return {
    id: String(row['id']),
    createdAt,
    createdAtUtc: new Date(createdAt * 1000).toISOString(),
    tzOffset: num(row['tz_offset']),
    localDate: String(row['local_date']),
    localTime: String(row['local_time']),
    weekday: num(row['weekday']),
    shout: str(row['shout']),
    venueId: str(row['venue_id']),
    venueName: str(row['venue_name']),
    lat: optNum(row['lat']),
    lng: optNum(row['lng']),
    address: str(row['address']),
    city: str(row['city']),
    state: str(row['state']),
    country: str(row['country']),
    countryCode: str(row['country_code']),
    categoryName: str(row['category_name']),
    photoCount: num(row['photo_count']),
    likeCount: num(row['like_count']),
    commentCount: num(row['comment_count']),
    withCount: num(row['with_count']),
    isMayor: row['is_mayor'] === 1,
    isPrivate: row['is_private'] === 1,
    sourceName: str(row['source_name']),
    stickerName: str(row['sticker_name']),
    eventName: str(row['event_name']),
  };
}

export interface Mark {
  readonly id: string;
  readonly createdAt: number;
}

export interface GroupCount {
  readonly key: string;
  readonly label: string;
  readonly count: number;
  readonly first: string;
  readonly last: string;
}

/** A venue, with enough context to be recognisable without a second lookup. */
export interface VenueRow extends GroupCount {
  readonly category: string | null;
  readonly city: string | null;
  readonly countryCode: string | null;
}

export const VENUE_SORTS = ['visits', 'recent', 'first', 'name'] as const;
export type VenueSort = (typeof VENUE_SORTS)[number];

/** `venue_id` breaks every tie, so paging cannot drop or repeat a venue. */
const VENUE_ORDER: Record<VenueSort, string> = {
  visits: 'n DESC, last_ts DESC, venue_id',
  recent: 'last_ts DESC, venue_id',
  first: 'first_ts ASC, venue_id',
  name: 'label COLLATE NOCASE ASC, venue_id',
};

export interface VocabularyMatches {
  readonly venues: readonly GroupCount[];
  readonly categories: readonly GroupCount[];
  readonly cities: readonly GroupCount[];
  readonly countries: readonly GroupCount[];
}

export interface ArchiveSummary {
  readonly total: number;
  readonly firstCheckin: string | null;
  readonly lastCheckin: string | null;
  readonly venues: number;
  readonly cities: number;
  readonly countries: number;
  readonly withPhotos: number;
  readonly withShout: number;
  readonly withFriends: number;
}

export interface CheckinDetail extends StoredCheckin {
  readonly photos: ReadonlyArray<{
    readonly photoId: string;
    readonly url: string | null;
    readonly width: number | null;
    readonly height: number | null;
  }>;
  readonly categories: ReadonlyArray<{ readonly name: string | null; readonly isPrimary: boolean }>;
  readonly companions: ReadonlyArray<{ readonly name: string; readonly userId: string | null }>;
  /** The verbatim API object, parsed. */
  readonly raw: unknown;
}

/** What to write for one check-in: its rows plus the JSON they came from. */
export interface Indexable {
  readonly normalised: NormalisedCheckin;
  readonly rawJson: string;
}

export interface OpenResult {
  readonly index: CheckinIndex;
  /**
   * True when the file on disk was written by a different schema version and
   * has been recreated empty. The raw JSONL is untouched; `reindex` refills it.
   */
  readonly rebuildRequired: boolean;
}

export class CheckinIndex {
  private constructor(private readonly db: Database.Database) {}

  /**
   * Opens the index, creating or recreating the schema as needed.
   *
   * A version mismatch drops every table rather than migrating. That is only
   * defensible because nothing here is authoritative — and it is reported
   * upwards so the caller can tell the user to re-index instead of silently
   * presenting an empty archive as an empty history.
   */
  static open(path: string): OpenResult {
    const db = new Database(path);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    const found = Number((db.pragma('user_version', { simple: true }) as number) ?? 0);
    const existing = db
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'checkins'")
      .get() as { n: number };

    let rebuildRequired = false;
    if (existing.n > 0 && found !== SCHEMA_VERSION) {
      for (const table of [
        'checkins',
        'checkin_photos',
        'checkin_categories',
        'checkin_companions',
      ]) {
        db.exec(`DROP TABLE IF EXISTS ${table}`);
      }
      db.exec('DROP TABLE IF EXISTS checkins_fts');
      rebuildRequired = true;
    }

    db.exec(SCHEMA);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
    return { index: new CheckinIndex(db), rebuildRequired };
  }

  /** A second, genuinely read-only handle — see `CheckinIndex.query`. */
  static openReadOnly(path: string): Database.Database {
    return new Database(path, { readonly: true, fileMustExist: true });
  }

  close(): void {
    this.db.close();
  }

  /** Empties every table, for a rebuild from the raw files. */
  clear(): void {
    this.db.exec(
      'DELETE FROM checkins; DELETE FROM checkin_photos; ' +
        'DELETE FROM checkin_categories; DELETE FROM checkin_companions; ' +
        'DELETE FROM checkins_fts;',
    );
  }

  /**
   * Writes a batch, replacing anything already stored under the same ids.
   *
   * Replace rather than ignore: a re-fetched check-in carries updated like and
   * comment counts, and it may have gained photos. The newest copy wins, which
   * matches the raw reader keeping the last line for an id.
   *
   * One transaction for the batch. Per-row transactions on a backfill of tens
   * of thousands of rows spend all their time in fsync.
   */
  upsert(batch: readonly Indexable[]): number {
    if (batch.length === 0) return 0;

    const insertCheckin = this.db.prepare(`
      INSERT OR REPLACE INTO checkins (
        id, created_at, tz_offset, local_ts, local_date, local_time, weekday, type, shout,
        venue_id, venue_name, lat, lng, address, city, state, country, country_code, postal_code,
        category_id, category_name, photo_count, like_count, comment_count, post_count, with_count,
        is_mayor, is_private, visibility, source_name, sticker_name, event_name, raw,
        venue_name_fold, city_fold, country_fold, category_name_fold
      ) VALUES (
        @id, @createdAt, @tzOffset, @localTs, @localDate, @localTime, @weekday, @type, @shout,
        @venueId, @venueName, @lat, @lng, @address, @city, @state, @country, @countryCode, @postalCode,
        @categoryId, @categoryName, @photoCount, @likeCount, @commentCount, @postCount, @withCount,
        @isMayor, @isPrivate, @visibility, @sourceName, @stickerName, @eventName, @raw,
        @venueNameFold, @cityFold, @countryFold, @categoryNameFold
      )
    `);
    const deletePhotos = this.db.prepare('DELETE FROM checkin_photos WHERE checkin_id = ?');
    const deleteCategories = this.db.prepare('DELETE FROM checkin_categories WHERE checkin_id = ?');
    const deleteCompanions = this.db.prepare('DELETE FROM checkin_companions WHERE checkin_id = ?');
    const deleteFts = this.db.prepare('DELETE FROM checkins_fts WHERE checkin_id = ?');
    const insertPhoto = this.db.prepare(`
      INSERT OR REPLACE INTO checkin_photos (checkin_id, photo_id, prefix, suffix, width, height, created_at)
      VALUES (@checkinId, @photoId, @prefix, @suffix, @width, @height, @createdAt)
    `);
    const insertCategory = this.db.prepare(`
      INSERT INTO checkin_categories (checkin_id, category_id, name, plural_name, is_primary)
      VALUES (@checkinId, @categoryId, @name, @pluralName, @isPrimary)
    `);
    const insertCompanion = this.db.prepare(`
      INSERT INTO checkin_companions (checkin_id, user_id, first_name, last_name)
      VALUES (@checkinId, @userId, @firstName, @lastName)
    `);
    const insertFts = this.db.prepare(
      'INSERT INTO checkins_fts (checkin_id, text) VALUES (@checkinId, @text)',
    );

    // `undefined` is not a bindable SQLite value; every optional field has to
    // arrive as null. Missing fields are the norm here, not the exception.
    const bindable = (value: unknown): unknown => value ?? null;

    const write = this.db.transaction((items: readonly Indexable[]) => {
      for (const { normalised, rawJson } of items) {
        const { record, photos, categories, companions } = normalised;
        insertCheckin.run({
          id: record.id,
          createdAt: record.createdAt,
          tzOffset: record.tzOffset,
          localTs: record.localTs,
          localDate: record.localDate,
          localTime: record.localTime,
          weekday: record.weekday,
          type: bindable(record.type),
          shout: bindable(record.shout),
          venueId: bindable(record.venueId),
          venueName: bindable(record.venueName),
          lat: bindable(record.lat),
          lng: bindable(record.lng),
          address: bindable(record.address),
          city: bindable(record.city),
          state: bindable(record.state),
          country: bindable(record.country),
          countryCode: bindable(record.countryCode),
          postalCode: bindable(record.postalCode),
          categoryId: bindable(record.categoryId),
          categoryName: bindable(record.categoryName),
          photoCount: record.photoCount,
          likeCount: record.likeCount,
          commentCount: record.commentCount,
          postCount: record.postCount,
          withCount: record.withCount,
          isMayor: record.isMayor ? 1 : 0,
          isPrivate: record.isPrivate ? 1 : 0,
          visibility: bindable(record.visibility),
          sourceName: bindable(record.sourceName),
          stickerName: bindable(record.stickerName),
          eventName: bindable(record.eventName),
          raw: rawJson,
          venueNameFold: foldOrNull(record.venueName),
          cityFold: foldOrNull(record.city),
          countryFold: foldOrNull(record.country),
          categoryNameFold: foldOrNull(record.categoryName),
        });

        deletePhotos.run(record.id);
        deleteCategories.run(record.id);
        deleteCompanions.run(record.id);
        deleteFts.run(record.id);

        for (const photo of photos) {
          insertPhoto.run({
            checkinId: photo.checkinId,
            photoId: photo.photoId,
            prefix: bindable(photo.prefix),
            suffix: bindable(photo.suffix),
            width: bindable(photo.width),
            height: bindable(photo.height),
            createdAt: bindable(photo.createdAt),
          });
        }
        for (const category of categories) {
          insertCategory.run({
            checkinId: category.checkinId,
            categoryId: bindable(category.categoryId),
            name: bindable(category.name),
            pluralName: bindable(category.pluralName),
            isPrimary: category.isPrimary ? 1 : 0,
          });
        }
        for (const companion of companions) {
          insertCompanion.run({
            checkinId: companion.checkinId,
            userId: bindable(companion.userId),
            firstName: bindable(companion.firstName),
            lastName: bindable(companion.lastName),
          });
        }

        const text = searchableText(record);
        if (text !== '') insertFts.run({ checkinId: record.id, text });
      }
    });

    write(batch);
    return batch.length;
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM checkins').get() as { n: number }).n;
  }

  has(id: string): boolean {
    return this.db.prepare('SELECT 1 FROM checkins WHERE id = ?').get(id) !== undefined;
  }

  /** Which of these ids are already stored. One statement, not one per id. */
  known(ids: readonly string[]): ReadonlySet<string> {
    if (ids.length === 0) return new Set();
    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT id FROM checkins WHERE id IN (${placeholders})`)
      .all(...ids) as Array<{ id: string }>;
    return new Set(rows.map((row) => row.id));
  }

  private mark(order: 'DESC' | 'ASC'): Mark | undefined {
    const row = this.db
      .prepare(`SELECT id, created_at FROM checkins ORDER BY created_at ${order}, id ${order} LIMIT 1`)
      .get() as { id: string; created_at: number } | undefined;
    return row ? { id: row.id, createdAt: row.created_at } : undefined;
  }

  newest(): Mark | undefined {
    return this.mark('DESC');
  }

  oldest(): Mark | undefined {
    return this.mark('ASC');
  }

  list(
    filter: CheckinFilter,
    sort: SortOrder,
    limit: number,
    offset = 0,
  ): { readonly items: readonly StoredCheckin[]; readonly total: number; readonly applied: readonly string[] } {
    const compiled = compileFilter(filter);
    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM checkins WHERE ${compiled.where}`)
        .get(compiled.params) as { n: number }
    ).n;
    const rows = this.db
      .prepare(
        `SELECT ${LIST_COLUMNS} FROM checkins WHERE ${compiled.where} ` +
          `ORDER BY ${orderBy(sort)} LIMIT @limit OFFSET @offset`,
      )
      .all({ ...compiled.params, limit, offset }) as Row[];
    return { items: rows.map(toStored), total, applied: compiled.applied };
  }

  get(id: string): CheckinDetail | undefined {
    const row = this.db.prepare(`SELECT ${LIST_COLUMNS}, raw FROM checkins WHERE id = ?`).get(id) as
      | Row
      | undefined;
    if (!row) return undefined;

    const photos = (
      this.db
        .prepare(
          'SELECT photo_id, prefix, suffix, width, height FROM checkin_photos WHERE checkin_id = ?',
        )
        .all(id) as Row[]
    ).map((photo) => ({
      photoId: String(photo['photo_id']),
      url:
        typeof photo['prefix'] === 'string' && typeof photo['suffix'] === 'string'
          ? `${photo['prefix']}original${photo['suffix']}`
          : null,
      width: optNum(photo['width']),
      height: optNum(photo['height']),
    }));

    const categories = (
      this.db
        .prepare('SELECT name, is_primary FROM checkin_categories WHERE checkin_id = ?')
        .all(id) as Row[]
    ).map((category) => ({
      name: str(category['name']),
      isPrimary: category['is_primary'] === 1,
    }));

    const companions = (
      this.db
        .prepare('SELECT user_id, first_name, last_name FROM checkin_companions WHERE checkin_id = ?')
        .all(id) as Row[]
    ).map((companion) => ({
      userId: str(companion['user_id']),
      name: [str(companion['first_name']), str(companion['last_name'])]
        .filter((part): part is string => part !== null)
        .join(' '),
    }));

    let raw: unknown = null;
    try {
      raw = JSON.parse(String(row['raw']));
    } catch {
      // A raw column that will not parse means the row predates a fix or the
      // file was edited by hand. The rest of the detail is still worth showing.
      raw = null;
    }

    return { ...toStored(row), photos, categories, companions, raw };
  }

  summary(filter: CheckinFilter = {}): ArchiveSummary {
    const compiled = compileFilter(filter);
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*)                                    AS total,
           MIN(local_ts)                               AS first_ts,
           MAX(local_ts)                               AS last_ts,
           COUNT(DISTINCT venue_id)                    AS venues,
           COUNT(DISTINCT city)                        AS cities,
           COUNT(DISTINCT country_code)                AS countries,
           SUM(CASE WHEN photo_count > 0 THEN 1 ELSE 0 END) AS with_photos,
           SUM(CASE WHEN shout IS NOT NULL AND shout <> '' THEN 1 ELSE 0 END) AS with_shout,
           SUM(CASE WHEN with_count  > 0 THEN 1 ELSE 0 END) AS with_friends
         FROM checkins WHERE ${compiled.where}`,
      )
      .get(compiled.params) as Row;

    const day = (value: unknown): string | null =>
      typeof value === 'number' ? new Date(value * 1000).toISOString().slice(0, 10) : null;

    return {
      total: num(row['total']),
      firstCheckin: day(row['first_ts']),
      lastCheckin: day(row['last_ts']),
      venues: num(row['venues']),
      cities: num(row['cities']),
      countries: num(row['countries']),
      withPhotos: num(row['with_photos']),
      withShout: num(row['with_shout']),
      withFriends: num(row['with_friends']),
    };
  }

  /**
   * The venues matching a filter, one row each.
   *
   * The ordering is a parameter because the same question is asked two ways.
   * "Where do I go most" wants the ranking; "what places did I visit in Paris"
   * wants the enumeration, and ranking that by frequency buries the one-off
   * museum under the hotel you slept in four times.
   */
  venues(
    filter: CheckinFilter,
    sort: VenueSort,
    limit: number,
  ): { readonly items: readonly VenueRow[]; readonly total: number; readonly applied: readonly string[] } {
    const compiled = compileFilter(filter);
    const scope = `FROM checkins WHERE ${compiled.where} AND venue_id IS NOT NULL`;

    const total = (
      this.db
        .prepare(`SELECT COUNT(DISTINCT venue_id) AS n ${scope}`)
        .get(compiled.params) as { n: number }
    ).n;

    const rows = this.db
      .prepare(
        `SELECT venue_id AS key,
                COALESCE(MAX(venue_name), venue_id) AS label,
                MAX(category_name) AS category,
                MAX(city) AS city,
                MAX(country_code) AS country_code,
                COUNT(*) AS n,
                MIN(local_ts) AS first_ts,
                MAX(local_ts) AS last_ts
         ${scope}
         GROUP BY venue_id
         ORDER BY ${VENUE_ORDER[sort]}
         LIMIT @limit`,
      )
      .all({ ...compiled.params, limit }) as Row[];

    return {
      items: rows.map((row) => ({
        ...toGroupCount(row),
        category: str(row['category']),
        city: str(row['city']),
        countryCode: str(row['country_code']),
      })),
      total,
      applied: compiled.applied,
    };
  }

  /**
   * Distinct values matching a fragment, across the columns worth filtering by.
   *
   * This is the lookup that turns "bubble tea" into `Bubble Tea Shop`. Without
   * it, anything driving these tools has to guess the exact stored spelling of
   * a category or a city, and a guess that is one word off returns zero results
   * that read exactly like "you have never been there".
   */
  vocabulary(fragment: string, limit: number): VocabularyMatches {
    const pattern = `%${fold(fragment).replace(/[\\%_]/g, (character) => `\\${character}`)}%`;

    const distinct = (
      value: string,
      folded: string,
      extra = '',
    ): readonly GroupCount[] => {
      const rows = this.db
        .prepare(
          `SELECT ${value} AS key, ${value} AS label, COUNT(*) AS n,
                  MIN(local_ts) AS first_ts, MAX(local_ts) AS last_ts
           FROM checkins
           WHERE ${folded} LIKE @pattern ESCAPE '\\' AND ${value} IS NOT NULL AND ${value} <> ''
           ${extra}
           GROUP BY ${value}
           ORDER BY n DESC, label ASC
           LIMIT @limit`,
        )
        .all({ pattern, limit }) as Row[];
      return rows.map(toGroupCount);
    };

    return {
      venues: distinct('venue_name', 'venue_name_fold'),
      categories: distinct('category_name', 'category_name_fold'),
      cities: distinct('city', 'city_fold'),
      countries: distinct('country', 'country_fold'),
    };
  }

  /** Counts grouped by one of a fixed set of columns. */
  groupBy(
    dimension: 'category_name' | 'city' | 'country' | 'source_name' | 'sticker_name',
    filter: CheckinFilter,
    limit: number,
  ): readonly GroupCount[] {
    const compiled = compileFilter(filter);
    const rows = this.db
      .prepare(
        `SELECT ${dimension} AS key, ${dimension} AS label, COUNT(*) AS n,
                MIN(local_ts) AS first_ts, MAX(local_ts) AS last_ts
         FROM checkins
         WHERE ${compiled.where} AND ${dimension} IS NOT NULL AND ${dimension} <> ''
         GROUP BY ${dimension}
         ORDER BY n DESC, label ASC
         LIMIT @limit`,
      )
      .all({ ...compiled.params, limit }) as Row[];
    return rows.map(toGroupCount);
  }

  /** Check-ins per weekday (0 = Sunday) and per hour of the local day. */
  rhythm(filter: CheckinFilter): {
    readonly weekday: readonly number[];
    readonly hour: readonly number[];
  } {
    const compiled = compileFilter(filter);
    const weekday = new Array<number>(7).fill(0);
    const hour = new Array<number>(24).fill(0);

    for (const row of this.db
      .prepare(
        `SELECT weekday AS k, COUNT(*) AS n FROM checkins WHERE ${compiled.where} GROUP BY weekday`,
      )
      .all(compiled.params) as Row[]) {
      const key = num(row['k']);
      if (key >= 0 && key < 7) weekday[key] = num(row['n']);
    }

    for (const row of this.db
      .prepare(
        `SELECT CAST(substr(local_time, 1, 2) AS INTEGER) AS k, COUNT(*) AS n
         FROM checkins WHERE ${compiled.where} GROUP BY k`,
      )
      .all(compiled.params) as Row[]) {
      const key = num(row['k']);
      if (key >= 0 && key < 24) hour[key] = num(row['n']);
    }

    return { weekday, hour };
  }

  /**
   * Full-text search over shouts, venue names, places and categories.
   *
   * The caller's text is turned into a list of quoted FTS5 terms rather than
   * passed through. Raw FTS5 syntax throws on a stray quote or a leading `-`,
   * and a search box that crashes on an apostrophe is not a search box.
   */
  search(
    text: string,
    filter: CheckinFilter,
    limit: number,
  ): { readonly items: readonly StoredCheckin[]; readonly total: number; readonly query: string } {
    const query = ftsQuery(text);
    if (query === '') return { items: [], total: 0, query };

    // No table prefixes are needed and none are added: every column the filter
    // touches exists on `checkins` alone, and the FTS table contributes only
    // `checkin_id` and `text`. Rewriting the compiled clause to qualify columns
    // would mean parsing SQL with a regex to fix an ambiguity that is not there.
    const compiled = compileFilter(filter);
    const from =
      'FROM checkins JOIN checkins_fts ON checkins_fts.checkin_id = checkins.id ' +
      `WHERE checkins_fts.text MATCH @fts AND ${compiled.where}`;
    const params = { ...compiled.params, fts: query, limit };

    const total = (this.db.prepare(`SELECT COUNT(*) AS n ${from}`).get(params) as { n: number }).n;
    const rows = this.db
      .prepare(`SELECT ${LIST_COLUMNS} ${from} ORDER BY rank, local_ts DESC LIMIT @limit`)
      .all(params) as Row[];
    return { items: rows.map(toStored), total, query };
  }

  /**
   * Runs a caller-supplied SELECT against a separate read-only connection.
   *
   * The escape hatch for questions nobody anticipated. Safety here is not a
   * regex over the statement — it is SQLite's own read-only mode, opened on a
   * second handle, so a statement that tries to write fails in the engine
   * rather than in a pattern somebody has to keep correct.
   *
   * @param path the index file, opened read-only for the duration of the call
   * @throws Error when the statement does not return rows, or SQLite rejects it
   */
  static query(
    path: string,
    sql: string,
    limit: number,
  ): { readonly rows: readonly Row[]; readonly truncated: boolean } {
    const db = CheckinIndex.openReadOnly(path);
    try {
      const statement = db.prepare(sql);
      if (!statement.reader) {
        throw new Error(
          'That statement does not return rows. This accepts SELECT queries only, ' +
            'and the connection it runs on is read-only.',
        );
      }
      const rows = statement.all() as Row[];
      return { rows: rows.slice(0, limit), truncated: rows.length > limit };
    } finally {
      db.close();
    }
  }

  /** Column names, so a caller writing SQL can find out what exists. */
  static schema(path: string): ReadonlyArray<{ table: string; columns: readonly string[] }> {
    const db = CheckinIndex.openReadOnly(path);
    try {
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type IN ('table') AND name NOT LIKE 'sqlite_%' " +
            "AND name NOT LIKE 'checkins_fts_%' ORDER BY name",
        )
        .all() as Array<{ name: string }>;
      return tables.map((table) => ({
        table: table.name,
        columns: (db.prepare(`PRAGMA table_info(${table.name})`).all() as Row[]).map((column) =>
          String(column['name']),
        ),
      }));
    } finally {
      db.close();
    }
  }
}

const toGroupCount = (row: Row): GroupCount => ({
  key: String(row['key'] ?? ''),
  label: String(row['label'] ?? row['key'] ?? ''),
  count: num(row['n']),
  first: new Date(num(row['first_ts']) * 1000).toISOString().slice(0, 10),
  last: new Date(num(row['last_ts']) * 1000).toISOString().slice(0, 10),
});

/**
 * Turns free text into an FTS5 MATCH expression.
 *
 * Each word becomes a quoted term, so every FTS5 operator in the input is
 * inert; a trailing `*` survives as a prefix search because that is the one
 * operator people actually reach for on purpose. Terms are ANDed, which is what
 * a multi-word search is expected to mean.
 */
export function ftsQuery(text: string): string {
  return text
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.replace(/[*"]/g, '') !== '')
    .map((word) => {
      const prefix = word.endsWith('*');
      const bare = (prefix ? word.slice(0, -1) : word).replace(/"/g, '');
      return `"${bare}"${prefix ? '*' : ''}`;
    })
    .join(' AND ');
}
