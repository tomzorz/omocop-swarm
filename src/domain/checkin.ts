/**
 * Turning a raw v2 check-in into rows.
 *
 * This file is deliberately paranoid. The archive spans as long as the account
 * has existed, and the response shape has moved over that time: venues acquired
 * and lost fields, `sticker` did not exist for the first years, `visibility`
 * arrived with private check-ins, and a venue that has since been deleted comes
 * back as a stub with a name and nothing else. Every field below the two
 * mandatory ones is therefore read defensively and allowed to be missing.
 *
 * The rule that keeps this honest: **normalisation may never fail on a
 * check-in it does not recognise.** The raw JSON is the archive's source of
 * truth and is written before any of this runs, so a field this file misreads
 * is fixable later by re-indexing. A field it throws on is a sync that stops
 * dead in 2013 and takes the rest of the decade with it.
 */

/** A property bag whose contents are unknown until inspected. */
type Raw = Record<string, unknown>;

const asObject = (value: unknown): Raw | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Raw)
    : undefined;

const asArray = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

const asString = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value.length > 0 ? value : undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
};

const asNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

const asBool = (value: unknown): boolean => value === true;

/** A `{ count, items }` envelope, of which v2 has many. Missing means zero. */
const countOf = (value: unknown): number => {
  const wrapper = asObject(value);
  if (!wrapper) return 0;
  const count = asNumber(wrapper['count']);
  return count ?? asArray(wrapper['items']).length;
};

const itemsOf = (value: unknown): readonly Raw[] =>
  asArray(asObject(value)?.['items'])
    .map(asObject)
    .filter((item): item is Raw => item !== undefined);

import { localStamp } from './time.js';

/** One row of the `checkins` table. */
export interface CheckinRecord {
  readonly id: string;
  /** Unix seconds, UTC. */
  readonly createdAt: number;
  /** The venue's offset from UTC in minutes, at that instant. */
  readonly tzOffset: number;
  /** Wall clock encoded as seconds — see domain/time.ts. */
  readonly localTs: number;
  readonly localDate: string;
  readonly localTime: string;
  readonly weekday: number;
  readonly type: string | undefined;
  readonly shout: string | undefined;
  readonly venueId: string | undefined;
  readonly venueName: string | undefined;
  readonly lat: number | undefined;
  readonly lng: number | undefined;
  readonly address: string | undefined;
  readonly city: string | undefined;
  readonly state: string | undefined;
  readonly country: string | undefined;
  readonly countryCode: string | undefined;
  readonly postalCode: string | undefined;
  /** The venue's primary category, denormalised for the common query. */
  readonly categoryId: string | undefined;
  readonly categoryName: string | undefined;
  readonly photoCount: number;
  readonly likeCount: number;
  readonly commentCount: number;
  readonly postCount: number;
  readonly withCount: number;
  readonly isMayor: boolean;
  readonly isPrivate: boolean;
  readonly visibility: string | undefined;
  readonly sourceName: string | undefined;
  readonly stickerName: string | undefined;
  readonly eventName: string | undefined;
}

export interface PhotoRow {
  readonly checkinId: string;
  readonly photoId: string;
  /** A photo URL is `prefix` + a size like `original` or `300x300` + `suffix`. */
  readonly prefix: string | undefined;
  readonly suffix: string | undefined;
  readonly width: number | undefined;
  readonly height: number | undefined;
  readonly createdAt: number | undefined;
}

export interface CategoryRow {
  readonly checkinId: string;
  readonly categoryId: string | undefined;
  readonly name: string | undefined;
  readonly pluralName: string | undefined;
  readonly isPrimary: boolean;
}

export interface CompanionRow {
  readonly checkinId: string;
  readonly userId: string | undefined;
  readonly firstName: string | undefined;
  readonly lastName: string | undefined;
}

export interface NormalisedCheckin {
  readonly record: CheckinRecord;
  readonly photos: readonly PhotoRow[];
  readonly categories: readonly CategoryRow[];
  readonly companions: readonly CompanionRow[];
}

export class UnusableCheckinError extends Error {
  override readonly name = 'UnusableCheckinError';
}

/**
 * Builds a photo URL at the requested size.
 *
 * Kept here rather than in the store because it is the one piece of photo
 * handling this archive does: the bytes are deliberately not downloaded, so the
 * URL is the whole of what is retained, and it has to be reassembled from the
 * two halves the API splits it into.
 *
 * @param size `original`, or a `WIDTHxHEIGHT` like `300x300`
 */
export function photoUrl(photo: PhotoRow, size = 'original'): string | undefined {
  if (!photo.prefix || !photo.suffix) return undefined;
  return `${photo.prefix}${size}${photo.suffix}`;
}

/**
 * Normalises one raw check-in.
 *
 * @throws UnusableCheckinError only when `id` or `createdAt` is absent — the two
 *   fields without which a row can neither be stored nor deduplicated. This is
 *   the sole failure mode by design; see the file comment.
 */
export function normaliseCheckin(raw: Raw): NormalisedCheckin {
  const id = asString(raw['id']);
  const createdAt = asNumber(raw['createdAt']);

  if (!id) throw new UnusableCheckinError('A check-in arrived without an id.');
  if (createdAt === undefined) {
    throw new UnusableCheckinError(`Check-in ${id} arrived without a createdAt.`);
  }

  // A missing offset is treated as UTC rather than as the host machine's zone.
  // Guessing the local machine would produce a wall clock that is wrong in a
  // way nothing downstream can detect; UTC is at least wrong in a stated way.
  const tzOffset = asNumber(raw['timeZoneOffset']) ?? 0;
  const stamp = localStamp(createdAt, tzOffset);

  const venue = asObject(raw['venue']);
  const location = asObject(venue?.['location']);
  const categories = asArray(venue?.['categories'])
    .map(asObject)
    .filter((category): category is Raw => category !== undefined);
  const primary = categories.find((category) => asBool(category['primary'])) ?? categories[0];

  const record: CheckinRecord = {
    id,
    createdAt,
    tzOffset,
    localTs: stamp.localTs,
    localDate: stamp.date,
    localTime: stamp.time,
    weekday: stamp.weekday,
    type: asString(raw['type']),
    shout: asString(raw['shout']),
    venueId: asString(venue?.['id']),
    venueName: asString(venue?.['name']),
    lat: asNumber(location?.['lat']),
    lng: asNumber(location?.['lng']),
    address: asString(location?.['address']),
    city: asString(location?.['city']),
    state: asString(location?.['state']),
    country: asString(location?.['country']),
    countryCode: asString(location?.['cc']),
    postalCode: asString(location?.['postalCode']),
    categoryId: asString(primary?.['id']),
    categoryName: asString(primary?.['name']),
    photoCount: countOf(raw['photos']),
    likeCount: countOf(raw['likes']),
    commentCount: countOf(raw['comments']),
    postCount: countOf(raw['posts']),
    withCount: asArray(raw['with']).length,
    isMayor: asBool(raw['isMayor']),
    isPrivate: asBool(raw['private']),
    visibility: asString(raw['visibility']),
    sourceName: asString(asObject(raw['source'])?.['name']),
    stickerName: asString(asObject(raw['sticker'])?.['name']),
    eventName: asString(asObject(raw['event'])?.['name']),
  };

  const photos: PhotoRow[] = itemsOf(raw['photos']).map((photo, index) => ({
    checkinId: id,
    // Photos predating photo ids exist; the index keeps the row addressable and
    // is stable because the array order in a stored check-in never changes.
    photoId: asString(photo['id']) ?? `${id}#${index}`,
    prefix: asString(photo['prefix']),
    suffix: asString(photo['suffix']),
    width: asNumber(photo['width']),
    height: asNumber(photo['height']),
    createdAt: asNumber(photo['createdAt']),
  }));

  const categoryRows: CategoryRow[] = categories.map((category) => ({
    checkinId: id,
    categoryId: asString(category['id']),
    name: asString(category['name']),
    pluralName: asString(category['pluralName']),
    isPrimary: asBool(category['primary']),
  }));

  const companions: CompanionRow[] = asArray(raw['with'])
    .map(asObject)
    .filter((friend): friend is Raw => friend !== undefined)
    .map((friend) => ({
      checkinId: id,
      userId: asString(friend['id']),
      firstName: asString(friend['firstName']),
      lastName: asString(friend['lastName']),
    }));

  return { record, photos, categories: categoryRows, companions };
}

/** The text a full-text search should match against, assembled once. */
export function searchableText(record: CheckinRecord): string {
  return [
    record.shout,
    record.venueName,
    record.address,
    record.city,
    record.state,
    record.country,
    record.categoryName,
    record.stickerName,
    record.eventName,
  ]
    .filter((part): part is string => part !== undefined)
    .join(' ');
}
