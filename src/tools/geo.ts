/**
 * Geographic queries.
 *
 * Two stages, and the reason is in domain/geo.ts: SQLite gets a bounding box it
 * can use an index for, and the exact circle is cut here over the survivors. A
 * haversine in the WHERE clause would be correct and would also read every row
 * in the table.
 */
import { z } from 'zod';
import { assertPoint, boundingBox, distanceMeters } from '../domain/geo.js';
import { defineTool } from '../server/tool.js';
import { CheckinShape, checkinLine, filterInput, toCheckinOut, toFilter } from './support.js';

const checkinsNear = defineTool({
  name: 'checkins-near',
  title: 'Check-ins near a point',
  description:
    'Finds archived check-ins within a radius of a latitude and longitude, nearest first, with ' +
    'the distance in metres. Accepts the same date and place filters as list-checkins, so it can ' +
    'answer things like which cafes near an address you visited in a given year. Reads the local ' +
    'archive only.',
  requires: 'archive',
  annotations: { readOnlyHint: true },
  input: {
    lat: z.number().min(-90).max(90).describe('Latitude of the centre point.'),
    lng: z.number().min(-180).max(180).describe('Longitude of the centre point.'),
    radius: z
      .number()
      .min(1)
      .max(500_000)
      .default(500)
      .describe('Search radius in metres. Default 500.'),
    ...filterInput,
    limit: z.number().int().min(1).max(500).default(50).describe('Maximum results.'),
  },
  output: {
    checkins: z.array(CheckinShape.extend({ distanceMeters: z.number() })),
    total: z.number().describe('Check-ins inside the radius, before the limit.'),
    withoutCoordinates: z
      .number()
      .describe('Matching check-ins skipped because the venue had no coordinates.'),
    notes: z.array(z.string()),
  },
  handler: async (args, ctx) => {
    const centre = { lat: args.lat, lng: args.lng };
    assertPoint(centre, 'centre');

    const filter = { ...toFilter(args, ctx.config.dayStartHour), box: boundingBox(centre, args.radius) };

    // The box is fetched without a limit because the limit applies to the
    // circle, not the square: cutting at 50 rows here would drop nearer
    // check-ins in favour of corner ones that are about to be discarded.
    const inBox = ctx.archive.index.list(filter, 'newest', 100_000, 0);

    const measured = inBox.items
      .filter((checkin) => checkin.lat !== null && checkin.lng !== null)
      .map((checkin) => ({
        checkin,
        distance: distanceMeters(centre, { lat: checkin.lat as number, lng: checkin.lng as number }),
      }))
      .filter((entry) => entry.distance <= args.radius)
      .sort((a, b) => a.distance - b.distance);

    // Reported rather than silently dropped: a venue with no coordinates is
    // invisible to every geographic query, and "no results" is a different fact
    // from "no results, and forty matches that could not be placed at all".
    const withoutCoordinates = ctx.archive.index.list(
      { ...toFilter(args, ctx.config.dayStartHour), hasCoordinates: false },
      'newest',
      1,
      0,
    ).total;

    const caveat = ctx.archive.caveat();
    const notes: string[] = caveat ? [caveat] : [];

    return {
      checkins: measured.slice(0, args.limit).map((entry) => ({
        ...toCheckinOut(entry.checkin),
        distanceMeters: Math.round(entry.distance),
      })),
      total: measured.length,
      withoutCoordinates,
      notes,
    };
  },
  render: (data) => {
    if (data.checkins.length === 0) {
      return [
        'No archived check-ins inside that radius.',
        ...data.notes,
        'Try a larger radius, or check the coordinates are the right way round (latitude first).',
      ].join('\n');
    }
    const head =
      data.checkins.length === data.total
        ? `${data.total} check-in${data.total === 1 ? '' : 's'} in range:`
        : `Nearest ${data.checkins.length} of ${data.total} check-ins in range:`;
    const lines = data.checkins.map(
      (checkin) => `  ${String(checkin.distanceMeters).padStart(6)}m  ${checkinLine(checkin)}`,
    );
    const tail =
      data.withoutCoordinates > 0
        ? [
            `\n${data.withoutCoordinates} check-in(s) matching the other filters have no coordinates at all ` +
              'and cannot appear in any geographic query.',
          ]
        : [];
    return [head, '', ...lines, ...tail, ...data.notes].join('\n').trimEnd();
  },
});

export const geoTools = [checkinsNear];
