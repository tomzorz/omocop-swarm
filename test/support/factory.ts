/**
 * Builders for raw check-ins, shaped like the ones the API really returns.
 *
 * The default is a fully populated check-in because that is what most tests
 * want to read fields off; the sparse and hostile variants exist because a
 * fifteen-year archive contains both and normalisation has to survive them.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, type Logger } from '../../src/logging.js';
import { archivePaths, ensureArchive, type ArchivePaths } from '../../src/store/paths.js';

export interface CheckinOverrides {
  readonly id?: string;
  readonly createdAt?: number;
  readonly timeZoneOffset?: number;
  readonly venueName?: string;
  readonly venueId?: string;
  readonly lat?: number;
  readonly lng?: number;
  readonly city?: string;
  readonly country?: string;
  readonly cc?: string;
  readonly category?: string;
  readonly shout?: string;
  readonly photos?: number;
  readonly likes?: number;
  readonly friends?: number;
}

/** 2019-06-12 21:34 in a +02:00 zone. */
export const BASE_CREATED_AT = 1_560_368_040;

export function makeCheckin(overrides: CheckinOverrides = {}): Record<string, unknown> {
  const photos = overrides.photos ?? 0;
  const friends = overrides.friends ?? 0;

  return {
    id: overrides.id ?? 'checkin-1',
    createdAt: overrides.createdAt ?? BASE_CREATED_AT,
    type: 'checkin',
    timeZoneOffset: overrides.timeZoneOffset ?? 120,
    ...(overrides.shout !== undefined ? { shout: overrides.shout } : {}),
    venue: {
      id: overrides.venueId ?? 'venue-1',
      name: overrides.venueName ?? 'Kisüzem',
      location: {
        address: 'Kis Diófa u. 2',
        lat: overrides.lat ?? 47.4979,
        lng: overrides.lng ?? 19.0602,
        postalCode: '1077',
        cc: overrides.cc ?? 'HU',
        city: overrides.city ?? 'Budapest',
        state: 'Budapest',
        country: overrides.country ?? 'Hungary',
        formattedAddress: ['Kis Diófa u. 2', 'Budapest', 'Hungary'],
      },
      categories: [
        {
          id: 'cat-bar',
          name: overrides.category ?? 'Bar',
          pluralName: `${overrides.category ?? 'Bar'}s`,
          shortName: overrides.category ?? 'Bar',
          icon: { prefix: 'https://ss3.4sqi.net/img/categories_v2/nightlife/bar_', suffix: '.png' },
          primary: true,
        },
        {
          id: 'cat-pub',
          name: 'Pub',
          pluralName: 'Pubs',
          shortName: 'Pub',
          icon: { prefix: 'https://ss3.4sqi.net/img/categories_v2/nightlife/pub_', suffix: '.png' },
        },
      ],
    },
    likes: { count: overrides.likes ?? 0, groups: [] },
    photos: {
      count: photos,
      items: Array.from({ length: photos }, (_unused, index) => ({
        id: `photo-${index}`,
        createdAt: (overrides.createdAt ?? BASE_CREATED_AT) + index,
        prefix: 'https://fastly.4sqi.net/img/general/',
        suffix: `/12345_photo${index}.jpg`,
        width: 1920,
        height: 1440,
      })),
    },
    comments: { count: 0 },
    posts: { count: 0, textCount: 0 },
    with: Array.from({ length: friends }, (_unused, index) => ({
      id: `friend-${index}`,
      firstName: 'Friend',
      lastName: String(index),
    })),
    source: { name: 'Swarm for iOS', url: 'https://www.swarmapp.com' },
    isMayor: false,
    private: false,
    visibility: 'closeFriends',
  };
}

/** A run of check-ins one hour apart, newest last. */
export function makeCheckins(count: number, startAt = BASE_CREATED_AT): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_unused, index) =>
    makeCheckin({
      id: `checkin-${String(index).padStart(4, '0')}`,
      createdAt: startAt + index * 3600,
      venueName: `Venue ${index % 7}`,
      venueId: `venue-${index % 7}`,
      ...(index % 3 === 0 ? { shout: `shout number ${index}` } : {}),
      photos: index % 5 === 0 ? 2 : 0,
    }),
  );
}

/** Everything optional stripped away — a venue that no longer exists. */
export const sparseCheckin = (id = 'sparse-1', createdAt = BASE_CREATED_AT): Record<string, unknown> => ({
  id,
  createdAt,
  venue: { name: 'A place that went away' },
});

/** Fields present but of the wrong type, which fifteen years of API produce. */
export const hostileCheckin = (id = 'hostile-1'): Record<string, unknown> => ({
  id,
  createdAt: BASE_CREATED_AT,
  timeZoneOffset: 'sixty',
  shout: 42,
  venue: 'not an object',
  photos: 'nope',
  likes: { count: 'many' },
  with: 'not an array',
  categories: null,
});

export interface Workspace {
  readonly dir: string;
  readonly paths: ArchivePaths;
  readonly logger: Logger;
  readonly logs: string[];
  cleanup(): void;
}

/** A throwaway archive directory with a capturing logger. */
export function workspace(): Workspace {
  const dir = mkdtempSync(join(tmpdir(), 'omocop-swarm-test-'));
  const paths = archivePaths(dir);
  ensureArchive(paths);
  const logs: string[] = [];
  const logger = createLogger('debug', (chunk) => logs.push(chunk));
  return {
    dir,
    paths,
    logger,
    logs,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
