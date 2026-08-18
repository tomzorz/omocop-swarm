/**
 * The two tools that exist because of how the questions are actually phrased.
 *
 * Everything else here takes a filter and hands back rows. But "when did I last
 * go to a bubble tea place" does not want rows, it wants a sentence with a date
 * and a gap in it; and asking it at all requires already knowing that the
 * archive spells the category `Bubble Tea Shop`. Both of those are answerable
 * with the existing tools and neither is answerable *comfortably*, which is the
 * whole difference between a query surface and a usable one.
 */
import { z } from 'zod';
import { humanDuration } from '../domain/time.js';
import { defineTool } from '../server/tool.js';
import {
  CheckinShape,
  checkinLine,
  filterInput,
  toCheckinOut,
  toFilter,
} from './support.js';

const lastVisit = defineTool({
  name: 'last-visit',
  title: 'When was I last (or first) somewhere',
  description:
    'Answers "when did I last go to X" and "when was the first time" for any filter: a venue, a ' +
    'category, a city, a country, or a combination. Returns the most recent and the earliest ' +
    'matching check-in, how long ago the last one was, and how many there have been in total. Use ' +
    'find-filters first if you are unsure how the archive spells the thing you are asking about. ' +
    'Reads the local archive only.',
  requires: 'archive',
  annotations: { readOnlyHint: true },
  input: { ...filterInput },
  output: {
    found: z.boolean(),
    last: CheckinShape.nullable(),
    first: CheckinShape.nullable(),
    visits: z.number(),
    daysSinceLast: z.number().nullable(),
    applied: z.array(z.string()),
    notes: z.array(z.string()),
  },
  handler: async (args, ctx) => {
    const filter = toFilter(args, ctx.config.dayStartHour);
    const newest = ctx.archive.index.list(filter, 'newest', 1, 0);
    const caveat = ctx.archive.caveat();

    if (newest.items.length === 0) {
      return {
        found: false,
        last: null,
        first: null,
        visits: 0,
        daysSinceLast: null,
        applied: [...newest.applied],
        notes: caveat ? [caveat] : [],
      };
    }

    const oldest = ctx.archive.index.list(filter, 'oldest', 1, 0);
    const last = newest.items[0];

    return {
      found: true,
      last: last ? toCheckinOut(last) : null,
      first: oldest.items[0] ? toCheckinOut(oldest.items[0]) : null,
      visits: newest.total,
      // Measured from the UTC instant, not the wall clock, so "how long ago" is
      // a real elapsed duration rather than a subtraction of two local clocks
      // that may have been in different time zones.
      daysSinceLast: last
        ? Math.floor((Date.now() / 1000 - last.createdAt) / 86_400)
        : null,
      applied: [...newest.applied],
      notes: caveat ? [caveat] : [],
    };
  },
  render: (data) => {
    const scope = data.applied.length > 0 ? ` matching ${data.applied.join(', ')}` : '';
    if (!data.found || !data.last) {
      return [
        `No check-in${scope} is in the archive.`,
        ...data.notes,
        'If the spelling might be off, run find-filters with a word from it.',
      ].join('\n');
    }

    const ago =
      data.daysSinceLast === null
        ? ''
        : data.daysSinceLast === 0
          ? ' (today)'
          : ` (${humanDuration(data.daysSinceLast * 86_400)} ago)`;

    const lines = [`Last${scope}: ${data.last.localDate}${ago}`, `  ${checkinLine(data.last)}`];

    if (data.first && data.first.id !== data.last.id) {
      lines.push('', `First: ${data.first.localDate}`, `  ${checkinLine(data.first)}`);
    }
    lines.push('', `${data.visits} visit${data.visits === 1 ? '' : 's'} in total.`);
    return [...lines, ...data.notes.map((note) => `\n${note}`)].join('\n').trimEnd();
  },
});

const MatchShape = z.object({
  value: z.string().describe('The exact stored value, to pass to another tool.'),
  checkins: z.number(),
  first: z.string(),
  last: z.string(),
});

const findFilters = defineTool({
  name: 'find-filters',
  title: 'Find what to filter by',
  description:
    'Given a word or fragment, returns the venues, categories, cities and countries in the archive ' +
    'that contain it, with how many check-ins each has. Use it to turn a vague phrase like "bubble ' +
    'tea" or "paris" into the exact values the other tools filter on, and to find out whether ' +
    'something is in the archive at all before concluding it is not. Matching ignores case and ' +
    'accents, so "kulturalis" finds "Kulturális". Reads the local archive only.',
  requires: 'archive',
  annotations: { readOnlyHint: true },
  input: {
    query: z.string().min(1).describe('A word or part of one, e.g. "bubble", "paris", "airport".'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe('Maximum matches per kind.'),
  },
  output: {
    query: z.string(),
    venues: z.array(MatchShape),
    categories: z.array(MatchShape),
    cities: z.array(MatchShape),
    countries: z.array(MatchShape),
    totalMatches: z.number(),
    notes: z.array(z.string()),
  },
  handler: async (args, ctx) => {
    const found = ctx.archive.index.vocabulary(args.query, args.limit);
    const shape = (matches: typeof found.venues) =>
      matches.map((match) => ({
        value: match.label,
        checkins: match.count,
        first: match.first,
        last: match.last,
      }));

    const caveat = ctx.archive.caveat();
    return {
      query: args.query,
      venues: shape(found.venues),
      categories: shape(found.categories),
      cities: shape(found.cities),
      countries: shape(found.countries),
      totalMatches:
        found.venues.length + found.categories.length + found.cities.length + found.countries.length,
      notes: caveat ? [caveat] : [],
    };
  },
  render: (data) => {
    if (data.totalMatches === 0) {
      return [
        `Nothing in the archive matches "${data.query}".`,
        ...data.notes,
        'Matching ignores case and accents and looks at venue names, categories, cities and countries. Try a shorter fragment.',
      ].join('\n');
    }

    const section = (
      title: string,
      flag: string,
      matches: readonly { value: string; checkins: number; first: string; last: string }[],
    ): readonly string[] => {
      if (matches.length === 0) return [];
      const width = Math.max(...matches.map((match) => String(match.checkins).length));
      return [
        '',
        `${title} (pass as ${flag}):`,
        ...matches.map(
          (match) =>
            `  ${String(match.checkins).padStart(width)}x  ${match.value}  ${match.first} to ${match.last}`,
        ),
      ];
    };

    return [
      `Matches for "${data.query}":`,
      ...section('Categories', '--category', data.categories),
      ...section('Cities', '--city', data.cities),
      ...section('Countries', '--country', data.countries),
      ...section('Venues', '--venue', data.venues),
      ...data.notes.map((note) => `\n${note}`),
    ]
      .join('\n')
      .trimEnd();
  },
});

export const recallTools = [lastVisit, findFilters];
