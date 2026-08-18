/**
 * The aggregate view: where you keep going back to, and when.
 *
 * Everything here is a GROUP BY over the same filter the listing tools take, so
 * "my top bars in Berlin in 2019" is the same question as "my check-ins in
 * Berlin in 2019" with a different projection, and both are spelled the same
 * way.
 */
import { z } from 'zod';
import { defineTool } from '../server/tool.js';
import { VENUE_SORTS } from '../store/index-db.js';
import { weekdayName, filterInput, toFilter } from './support.js';

const GroupShape = z.object({
  key: z.string(),
  label: z.string(),
  count: z.number(),
  first: z.string().describe('Date of the earliest matching visit.'),
  last: z.string().describe('Date of the most recent matching visit.'),
});

const listVenues = defineTool({
  name: 'list-venues',
  title: 'List or rank the places you have been',
  description:
    'The distinct venues you have checked in to, with visit counts and the first and last time ' +
    'you were at each. Answers both "where do I go most" (sort by visits, the default) and "what ' +
    'places did I visit in Paris" (filter by city, sort by recent or name). Takes the same date ' +
    'and place filters as list-checkins. Reads the local archive only.',
  requires: 'archive',
  annotations: { readOnlyHint: true },
  input: {
    ...filterInput,
    sort: z
      .enum(VENUE_SORTS)
      .default('visits')
      .describe(
        'visits = most visited first; recent = most recently visited first; first = in the order you discovered them; name = alphabetical.',
      ),
    limit: z.number().int().min(1).max(500).default(20).describe('How many venues to return.'),
  },
  output: {
    venues: z.array(
      GroupShape.extend({
        category: z.string().nullable(),
        city: z.string().nullable(),
        countryCode: z.string().nullable(),
      }),
    ),
    total: z.number().describe('Distinct venues matching the filter, before the limit.'),
    sort: z.string(),
    applied: z.array(z.string()),
    notes: z.array(z.string()),
  },
  handler: async (args, ctx) => {
    const filter = toFilter(args, ctx.config.dayStartHour);
    const result = ctx.archive.index.venues(filter, args.sort, args.limit);
    const caveat = ctx.archive.caveat();
    return {
      venues: result.items.map((venue) => ({
        key: venue.key,
        label: venue.label,
        count: venue.count,
        first: venue.first,
        last: venue.last,
        category: venue.category,
        city: venue.city,
        countryCode: venue.countryCode,
      })),
      total: result.total,
      sort: args.sort,
      applied: [...result.applied],
      notes: caveat ? [caveat] : [],
    };
  },
  render: (data) => {
    if (data.venues.length === 0) {
      return ['No venues matched.', ...data.notes].join('\n');
    }
    const scope = data.applied.length > 0 ? ` ${data.applied.join(', ')}` : '';
    const head =
      data.venues.length === data.total
        ? `${data.total} venue${data.total === 1 ? '' : 's'}${scope}:`
        : `${data.venues.length} of ${data.total} venues${scope}, by ${data.sort}:`;

    const width = Math.max(...data.venues.map((venue) => String(venue.count).length));
    return [
      head,
      '',
      ...data.venues.map((venue) => {
        const where = [venue.category, [venue.city, venue.countryCode].filter(Boolean).join(' ')]
          .filter((part) => part !== null && part !== '')
          .join(', ');
        return (
          `  ${String(venue.count).padStart(width)}x  ${venue.label}` +
          `${where ? `  (${where})` : ''}  ${venue.first} to ${venue.last}`
        );
      }),
      ...data.notes.map((note) => `\n${note}`),
    ]
      .join('\n')
      .trimEnd();
  },
});

const DIMENSIONS = {
  category: 'category_name',
  city: 'city',
  country: 'country',
  source: 'source_name',
  sticker: 'sticker_name',
} as const;

const breakdown = defineTool({
  name: 'checkin-breakdown',
  title: 'Break check-ins down by one dimension',
  description:
    'Counts check-ins grouped by category, city, country, the app they were posted from, or the ' +
    'sticker on them. Combine with the usual date and place filters to ask things like which ' +
    'categories dominated a particular year. Reads the local archive only.',
  requires: 'archive',
  annotations: { readOnlyHint: true },
  input: {
    by: z
      .enum(['category', 'city', 'country', 'source', 'sticker'])
      .describe('What to group by.'),
    ...filterInput,
    limit: z.number().int().min(1).max(200).default(25).describe('How many groups to return.'),
  },
  output: {
    by: z.string(),
    groups: z.array(GroupShape),
    notes: z.array(z.string()),
  },
  handler: async (args, ctx) => {
    const filter = toFilter(args, ctx.config.dayStartHour);
    const caveat = ctx.archive.caveat();
    return {
      by: args.by,
      groups: [...ctx.archive.index.groupBy(DIMENSIONS[args.by], filter, args.limit)],
      notes: caveat ? [caveat] : [],
    };
  },
  render: (data) => {
    if (data.groups.length === 0) {
      return [`Nothing to group by ${data.by}.`, ...data.notes].join('\n');
    }
    const width = String(data.groups[0]?.count ?? 0).length;
    return [
      `Check-ins by ${data.by}:`,
      '',
      ...data.groups.map(
        (group) =>
          `  ${String(group.count).padStart(width)}x  ${group.label}  (${group.first} to ${group.last})`,
      ),
      ...data.notes.map((note) => `\n${note}`),
    ]
      .join('\n')
      .trimEnd();
  },
});

const stats = defineTool({
  name: 'checkin-stats',
  title: 'Archive statistics',
  description:
    'Totals and rhythms for the archive or any slice of it: how many check-ins, over what span, ' +
    'across how many venues, cities and countries, and how they fall across the days of the week ' +
    'and the hours of the day. Takes the same filters as list-checkins. Reads the local archive only.',
  requires: 'archive',
  annotations: { readOnlyHint: true },
  input: { ...filterInput },
  output: {
    total: z.number(),
    firstCheckin: z.string().nullable(),
    lastCheckin: z.string().nullable(),
    venues: z.number(),
    cities: z.number(),
    countries: z.number(),
    withPhotos: z.number(),
    withShout: z.number(),
    withFriends: z.number(),
    byWeekday: z.array(z.object({ weekday: z.string(), count: z.number() })),
    byHour: z.array(z.object({ hour: z.number(), count: z.number() })),
    notes: z.array(z.string()),
  },
  handler: async (args, ctx) => {
    const filter = toFilter(args, ctx.config.dayStartHour);
    const summary = ctx.archive.index.summary(filter);
    const rhythm = ctx.archive.index.rhythm(filter);
    const caveat = ctx.archive.caveat();
    return {
      ...summary,
      byWeekday: rhythm.weekday.map((count, index) => ({ weekday: weekdayName(index), count })),
      byHour: rhythm.hour.map((count, hour) => ({ hour, count })),
      notes: caveat ? [caveat] : [],
    };
  },
  render: (data) => {
    if (data.total === 0) {
      return ['No check-ins matched.', ...data.notes].join('\n');
    }
    const busiestDay = [...data.byWeekday].sort((a, b) => b.count - a.count)[0];
    const busiestHour = [...data.byHour].sort((a, b) => b.count - a.count)[0];

    return [
      `${count(data.total, 'check-in')} from ${data.firstCheckin} to ${data.lastCheckin}.`,
      `${count(data.venues, 'venue')}, ${count(data.cities, 'city', 'cities')}, ` +
        `${count(data.countries, 'country', 'countries')}.`,
      `${data.withPhotos} with photos, ${data.withShout} with something written, ${data.withFriends} with company.`,
      '',
      `Busiest day: ${busiestDay?.weekday} (${busiestDay?.count}).  ` +
        `Busiest hour: ${String(busiestHour?.hour).padStart(2, '0')}:00 (${busiestHour?.count}).`,
      '',
      histogram(data.byWeekday.map((entry) => ({ label: entry.weekday.slice(0, 3), count: entry.count }))),
      '',
      histogram(
        data.byHour.map((entry) => ({
          label: String(entry.hour).padStart(2, '0'),
          count: entry.count,
        })),
      ),
      ...data.notes.map((note) => `\n${note}`),
    ]
      .join('\n')
      .trimEnd();
  },
});

/** "1 city", "4 cities". An irregular plural is passed in rather than guessed. */
const count = (n: number, singular: string, plural = `${singular}s`): string =>
  `${n} ${n === 1 ? singular : plural}`;

/** A bar chart in text. Cheap, and reads far better than a column of numbers. */
function histogram(entries: ReadonlyArray<{ label: string; count: number }>): string {
  const peak = Math.max(1, ...entries.map((entry) => entry.count));
  const labelWidth = Math.max(...entries.map((entry) => entry.label.length));
  const countWidth = String(peak).length;
  return entries
    .map((entry) => {
      const bar = '#'.repeat(Math.round((entry.count / peak) * 24));
      return `  ${entry.label.padEnd(labelWidth)}  ${String(entry.count).padStart(countWidth)}  ${bar}`;
    })
    .join('\n');
}

export const placeTools = [listVenues, breakdown, stats];
