/**
 * Full-text search across the archive.
 *
 * Separate from `list-checkins` because it answers a different kind of
 * question. A filter narrows by fields you already know the value of; a search
 * finds the check-in when all you remember is a word — the name of a bar, half
 * a city, something you wrote at the time.
 */
import { z } from 'zod';
import { defineTool } from '../server/tool.js';
import {
  CheckinShape,
  checkinLine,
  filterInput,
  toCheckinOut,
  toFilter,
} from './support.js';

const searchCheckins = defineTool({
  name: 'search-checkins',
  title: 'Search check-ins',
  description:
    'Full-text search over what you wrote, venue names, addresses, cities, countries, categories ' +
    'and stickers. Several words are ANDed; end a word with * for a prefix match. The same date ' +
    'and place filters as list-checkins can narrow the search further. Reads the local archive only.',
  requires: 'archive',
  annotations: { readOnlyHint: true },
  input: {
    query: z
      .string()
      .min(1)
      .describe('Words to look for. "ramen tokyo" finds check-ins matching both; "kis*" matches by prefix.'),
    ...filterInput,
    limit: z.number().int().min(1).max(500).default(50).describe('Maximum results.'),
  },
  output: {
    checkins: z.array(CheckinShape),
    total: z.number().describe('Matches before the limit was applied.'),
    query: z.string().describe('The search expression that was actually run.'),
    notes: z.array(z.string()),
  },
  handler: async (args, ctx) => {
    const filter = toFilter(args, ctx.config.dayStartHour);
    const result = ctx.archive.index.search(args.query, filter, args.limit);
    const caveat = ctx.archive.caveat();
    return {
      checkins: result.items.map(toCheckinOut),
      total: result.total,
      query: result.query,
      notes: caveat ? [caveat] : [],
    };
  },
  render: (data) => {
    if (data.query === '') {
      return 'That search had no searchable words in it.';
    }
    if (data.checkins.length === 0) {
      return [
        `Nothing matched ${data.query}.`,
        ...data.notes,
        'Search covers shouts, venue names, addresses, cities, countries, categories and stickers — not photos or comments.',
      ].join('\n');
    }
    const head =
      data.checkins.length === data.total
        ? `${data.total} match${data.total === 1 ? '' : 'es'} for ${data.query}:`
        : `${data.checkins.length} of ${data.total} matches for ${data.query}:`;
    return [head, '', ...data.checkins.map((checkin) => `  ${checkinLine(checkin)}`), ...data.notes]
      .join('\n')
      .trimEnd();
  },
});

export const searchTools = [searchCheckins];
