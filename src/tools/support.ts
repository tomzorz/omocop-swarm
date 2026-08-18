/**
 * Shapes and renderers shared by the query tools.
 *
 * Every tool that returns check-ins returns the same shape and renders it the
 * same way. That is worth a shared file rather than a convention: a caller who
 * has learned to read one listing has learned to read all of them, and the
 * `describe` text on each field is what the CLI turns into flag help, so
 * writing it once keeps `--help` consistent across six subcommands.
 */
import { z } from 'zod';
import type { CheckinFilter, SortOrder } from '../domain/query.js';
import type { StoredCheckin } from '../store/index-db.js';

/** Filter fields, as tool input. Shared verbatim by every listing tool. */
export const filterInput = {
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.')
    .optional()
    .describe('First day, YYYY-MM-DD, in the time zone of the place. Alone, it means that one day.'),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.')
    .optional()
    .describe('Last day, YYYY-MM-DD, inclusive.'),
  dayStart: z
    .number()
    .int()
    .min(0)
    .max(23)
    .optional()
    .describe(
      'Hour a day is taken to start at, 0-23. At 6, a 02:00 check-in counts towards the night before.',
    ),
  venue: z.string().optional().describe('Part of the venue name, case-insensitive.'),
  venueId: z.string().optional().describe('Exact Foursquare venue id.'),
  category: z.string().optional().describe('Part of the venue category, e.g. "Coffee" or "Airport".'),
  city: z.string().optional().describe('Part of the city name.'),
  country: z.string().optional().describe('Country name, or a two-letter code like HU.'),
  withPhotos: z.boolean().optional().describe('Only check-ins that have photos.'),
  withShout: z.boolean().optional().describe('Only check-ins where you wrote something.'),
  withFriends: z.boolean().optional().describe('Only check-ins you were with somebody on.'),
} as const;

type FilterArgs = {
  from?: string;
  to?: string;
  dayStart?: number;
  venue?: string;
  venueId?: string;
  category?: string;
  city?: string;
  country?: string;
  withPhotos?: boolean;
  withShout?: boolean;
  withFriends?: boolean;
};

/** Builds the domain filter from tool arguments, applying the configured default day start. */
export function toFilter(args: FilterArgs, defaultDayStart: number): CheckinFilter {
  return {
    ...(args.from !== undefined ? { from: args.from } : {}),
    ...(args.to !== undefined ? { to: args.to } : {}),
    dayStartHour: args.dayStart ?? defaultDayStart,
    ...(args.venue !== undefined ? { venue: args.venue } : {}),
    ...(args.venueId !== undefined ? { venueId: args.venueId } : {}),
    ...(args.category !== undefined ? { category: args.category } : {}),
    ...(args.city !== undefined ? { city: args.city } : {}),
    ...(args.country !== undefined ? { country: args.country } : {}),
    ...(args.withPhotos === true ? { withPhotos: true } : {}),
    ...(args.withShout === true ? { withShout: true } : {}),
    ...(args.withFriends === true ? { withFriends: true } : {}),
  };
}

/** A check-in as every tool returns it. */
export const CheckinShape = z.object({
  id: z.string(),
  /** UTC instant, ISO 8601. */
  at: z.string(),
  /** Date and time on the clock where the check-in happened. */
  localDate: z.string(),
  localTime: z.string(),
  venue: z.string().nullable(),
  venueId: z.string().nullable(),
  category: z.string().nullable(),
  address: z.string().nullable(),
  city: z.string().nullable(),
  country: z.string().nullable(),
  countryCode: z.string().nullable(),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  shout: z.string().nullable(),
  photoCount: z.number(),
  likeCount: z.number(),
  friendCount: z.number(),
  isMayor: z.boolean(),
  isPrivate: z.boolean(),
  source: z.string().nullable(),
  sticker: z.string().nullable(),
});
export type CheckinOut = z.infer<typeof CheckinShape>;

export const toCheckinOut = (checkin: StoredCheckin): CheckinOut => ({
  id: checkin.id,
  at: checkin.createdAtUtc,
  localDate: checkin.localDate,
  localTime: checkin.localTime,
  venue: checkin.venueName,
  venueId: checkin.venueId,
  category: checkin.categoryName,
  address: checkin.address,
  city: checkin.city,
  country: checkin.country,
  countryCode: checkin.countryCode,
  lat: checkin.lat,
  lng: checkin.lng,
  shout: checkin.shout,
  photoCount: checkin.photoCount,
  likeCount: checkin.likeCount,
  friendCount: checkin.withCount,
  isMayor: checkin.isMayor,
  isPrivate: checkin.isPrivate,
  source: checkin.sourceName,
  sticker: checkin.stickerName,
});

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const weekdayName = (index: number): string => WEEKDAYS[index] ?? String(index);

/** Where a check-in was, as one phrase: "Kisüzem — Bar, Budapest HU". */
export function placeOf(checkin: CheckinOut): string {
  const parts: string[] = [checkin.venue ?? 'somewhere unnamed'];
  const qualifiers = [checkin.category, [checkin.city, checkin.countryCode].filter(Boolean).join(' ')]
    .filter((part) => part !== null && part !== '')
    .join(', ');
  if (qualifiers !== '') parts.push(qualifiers);
  return parts.join(' — ');
}

/** One check-in as a line. */
export function checkinLine(checkin: CheckinOut): string {
  const marks: string[] = [];
  if (checkin.photoCount > 0) {
    marks.push(`${checkin.photoCount} photo${checkin.photoCount === 1 ? '' : 's'}`);
  }
  if (checkin.friendCount > 0) marks.push(`with ${checkin.friendCount}`);
  if (checkin.isMayor) marks.push('mayor');
  if (checkin.isPrivate) marks.push('private');

  return (
    `${checkin.localDate} ${checkin.localTime}  ${placeOf(checkin)}` +
    `${checkin.shout ? `  "${checkin.shout}"` : ''}` +
    `${marks.length > 0 ? `  [${marks.join(', ')}]` : ''}`
  );
}

/** A listing, rendered. Notes are appended so nothing the tool had to say is lost. */
export function renderListing(
  items: readonly CheckinOut[],
  total: number,
  applied: readonly string[],
  notes: readonly string[],
  emptyHint: string,
): string {
  const scope = applied.length > 0 ? ` ${applied.join(', ')}` : '';
  if (items.length === 0) {
    return [`No check-ins${scope}.`, ...notes, emptyHint].filter(Boolean).join('\n');
  }

  const head =
    items.length === total
      ? `${total} check-in${total === 1 ? '' : 's'}${scope}:`
      : `${items.length} of ${total} check-ins${scope}:`;

  return [head, '', ...items.map((item) => `  ${checkinLine(item)}`), ...notes.map((n) => `\n${n}`)]
    .join('\n')
    .trimEnd();
}

export const SORT_INPUT = z
  .enum(['newest', 'oldest'])
  .default('newest')
  .describe('Order of the results.');

export const sortOf = (value: string): SortOrder => (value === 'oldest' ? 'oldest' : 'newest');
