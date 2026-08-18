/**
 * Listing and reading check-ins out of the local archive.
 *
 * These two tools answer the question the archive exists for — "where was I" —
 * and they never touch the network. That is the point of having an archive: the
 * answer is instant, works offline, and does not depend on Foursquare still
 * being willing to serve a decade-old check-in.
 */
import { z } from 'zod';
import { defineTool } from '../server/tool.js';
import {
  CheckinShape,
  SORT_INPUT,
  checkinLine,
  filterInput,
  placeOf,
  renderListing,
  sortOf,
  toCheckinOut,
  toFilter,
  weekdayName,
} from './support.js';

const listCheckins = defineTool({
  name: 'list-checkins',
  title: 'List check-ins',
  description:
    'Lists archived check-ins, newest first, with optional filters. For a single day, pass only ' +
    'from. For a range, pass from and to. Filters combine: from/to narrow by date, venue, ' +
    'category, city and country narrow by place, and withPhotos, withShout and withFriends narrow ' +
    'by what happened. Reads the local archive and never contacts Foursquare.',
  requires: 'archive',
  annotations: { readOnlyHint: true },
  input: {
    ...filterInput,
    sort: SORT_INPUT,
    limit: z.number().int().min(1).max(500).default(50).describe('Maximum check-ins to return.'),
    offset: z.number().int().min(0).default(0).describe('Skip this many results, for paging.'),
  },
  output: {
    checkins: z.array(CheckinShape),
    total: z.number().describe('Check-ins matching the filter, before limit and offset.'),
    applied: z.array(z.string()).describe('The filters that were applied, in words.'),
    notes: z.array(z.string()),
  },
  handler: async (args, ctx) => {
    const filter = toFilter(args, ctx.config.dayStartHour);
    const result = ctx.archive.index.list(filter, sortOf(args.sort), args.limit, args.offset);
    const caveat = ctx.archive.caveat();
    return {
      checkins: result.items.map(toCheckinOut),
      total: result.total,
      applied: [...result.applied],
      notes: caveat ? [caveat] : [],
    };
  },
  render: (data) =>
    renderListing(
      data.checkins,
      data.total,
      data.applied,
      data.notes,
      'Nothing matched. Widen the filter, or check that the archive is up to date with `sync-status`.',
    ),
});

const getCheckin = defineTool({
  name: 'get-checkin',
  title: 'Get one check-in',
  description:
    'Returns one archived check-in in full: place, coordinates, shout, photo URLs, who you were ' +
    'with, and every category the venue carried. Takes the id from any listing. Reads the local ' +
    'archive and never contacts Foursquare.',
  requires: 'archive',
  annotations: { readOnlyHint: true },
  input: {
    id: z.string().min(1).describe('Foursquare check-in id, as shown by list-checkins.'),
    includeRaw: z
      .boolean()
      .default(false)
      .describe('Include the verbatim API object the check-in was archived from.'),
  },
  output: {
    checkin: CheckinShape.nullable(),
    weekday: z.string().nullable(),
    photos: z.array(
      z.object({
        url: z.string().nullable().describe('Full-size image URL, reassembled from the stored halves.'),
        width: z.number().nullable(),
        height: z.number().nullable(),
      }),
    ),
    categories: z.array(z.string()),
    friends: z.array(z.string()),
    raw: z.unknown().nullable(),
    found: z.boolean(),
  },
  handler: async (args, ctx) => {
    const detail = ctx.archive.index.get(args.id);
    if (!detail) {
      return {
        checkin: null,
        weekday: null,
        photos: [],
        categories: [],
        friends: [],
        raw: null,
        found: false,
      };
    }
    return {
      checkin: toCheckinOut(detail),
      weekday: weekdayName(detail.weekday),
      photos: detail.photos.map((photo) => ({
        url: photo.url,
        width: photo.width,
        height: photo.height,
      })),
      categories: detail.categories
        .map((category) => category.name)
        .filter((name): name is string => name !== null),
      friends: detail.companions.map((companion) => companion.name).filter((name) => name !== ''),
      raw: args.includeRaw ? detail.raw : null,
      found: true,
    };
  },
  render: (data) => {
    if (!data.found || !data.checkin) {
      return 'No check-in with that id is in the archive. Run `sync` if it is recent, or `reindex` if the index was rebuilt.';
    }
    const checkin = data.checkin;
    const lines = [
      `${data.weekday} ${checkin.localDate} at ${checkin.localTime} (local time where you were)`,
      placeOf(checkin),
    ];
    if (checkin.address) lines.push(checkin.address);
    if (checkin.lat !== null && checkin.lng !== null) {
      lines.push(`${checkin.lat}, ${checkin.lng}`);
    }
    if (checkin.shout) lines.push(`\n"${checkin.shout}"`);
    if (data.categories.length > 1) lines.push(`\nCategories: ${data.categories.join(', ')}`);
    if (data.friends.length > 0) lines.push(`With: ${data.friends.join(', ')}`);
    if (checkin.likeCount > 0) lines.push(`Likes: ${checkin.likeCount}`);
    if (checkin.sticker) lines.push(`Sticker: ${checkin.sticker}`);
    if (checkin.source) lines.push(`Posted from: ${checkin.source}`);
    if (data.photos.length > 0) {
      lines.push(
        `\nPhotos (${data.photos.length}, links only — the archive stores metadata, not the images):`,
      );
      for (const photo of data.photos) if (photo.url) lines.push(`  ${photo.url}`);
    }
    lines.push(`\nid ${checkin.id}${checkin.venueId ? `  venue ${checkin.venueId}` : ''}`);
    return lines.join('\n');
  },
});

const recentCheckins = defineTool({
  name: 'recent-checkins',
  title: 'Recent check-ins',
  description:
    'The most recently archived check-ins, newest first. A quick look at what the archive holds ' +
    'at its top end, without composing a filter. Reads the local archive only.',
  requires: 'archive',
  annotations: { readOnlyHint: true },
  input: {
    limit: z.number().int().min(1).max(200).default(20).describe('How many to show.'),
  },
  output: {
    checkins: z.array(CheckinShape),
    total: z.number(),
    notes: z.array(z.string()),
  },
  handler: async (args, ctx) => {
    const result = ctx.archive.index.list({}, 'newest', args.limit, 0);
    const caveat = ctx.archive.caveat();
    return {
      checkins: result.items.map(toCheckinOut),
      total: result.total,
      notes: caveat ? [caveat] : [],
    };
  },
  render: (data) => {
    if (data.checkins.length === 0) {
      return ['The archive holds no check-ins.', ...data.notes].join('\n');
    }
    return [
      `Latest ${data.checkins.length} of ${data.total} archived check-ins:`,
      '',
      ...data.checkins.map((checkin) => `  ${checkinLine(checkin)}`),
      ...data.notes.map((note) => `\n${note}`),
    ]
      .join('\n')
      .trimEnd();
  },
});

export const checkinTools = [listCheckins, getCheckin, recentCheckins];
