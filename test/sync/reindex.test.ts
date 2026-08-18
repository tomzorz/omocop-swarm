import { appendFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CheckinIndex } from '../../src/store/index-db.js';
import { rawFileFor } from '../../src/store/paths.js';
import { appendRaw } from '../../src/store/raw.js';
import { reindex } from '../../src/sync/reindex.js';
import { BASE_CREATED_AT, makeCheckin, workspace, type Workspace } from '../support/factory.js';

let space: Workspace;
let index: CheckinIndex;

beforeEach(() => {
  space = workspace();
  index = CheckinIndex.open(space.paths.indexPath).index;
});
afterEach(() => {
  index.close();
  space.cleanup();
});

const write = (...checkins: Array<Record<string, unknown>>): void => {
  appendRaw(
    space.paths,
    checkins.map((checkin) => ({
      id: String(checkin['id']),
      createdAt: Number(checkin['createdAt']),
      localDate: '2019-06-12',
      checkin,
    })),
  );
};

describe('reindex', () => {
  it('builds the index from the raw files alone', async () => {
    write(makeCheckin({ id: 'a' }), makeCheckin({ id: 'b' }));
    const result = await reindex(space.paths, index, space.logger);

    expect(result.indexed).toBe(2);
    expect(result.linesRead).toBe(2);
    expect(index.count()).toBe(2);
    expect(index.get('a')?.venueName).toBe('Kisüzem');
  });

  it('empties the index first, so a rebuild is a rebuild and not a top-up', async () => {
    write(makeCheckin({ id: 'a' }));
    await reindex(space.paths, index, space.logger);

    index.upsert([
      {
        normalised: {
          record: {
            id: 'stale',
            createdAt: 1,
            tzOffset: 0,
            localTs: 1,
            localDate: '1970-01-01',
            localTime: '00:00',
            weekday: 4,
            type: undefined,
            shout: undefined,
            venueId: undefined,
            venueName: 'Stale',
            lat: undefined,
            lng: undefined,
            address: undefined,
            city: undefined,
            state: undefined,
            country: undefined,
            countryCode: undefined,
            postalCode: undefined,
            categoryId: undefined,
            categoryName: undefined,
            photoCount: 0,
            likeCount: 0,
            commentCount: 0,
            postCount: 0,
            withCount: 0,
            isMayor: false,
            isPrivate: false,
            visibility: undefined,
            sourceName: undefined,
            stickerName: undefined,
            eventName: undefined,
          },
          photos: [],
          categories: [],
          companions: [],
        },
        rawJson: '{}',
      },
    ]);
    expect(index.count()).toBe(2);

    await reindex(space.paths, index, space.logger);
    expect(index.count()).toBe(1);
    expect(index.has('stale')).toBe(false);
  });

  it('keeps the last copy when a check-in appears on several lines', async () => {
    write(makeCheckin({ id: 'a', likes: 1 }));
    write(makeCheckin({ id: 'a', likes: 9 }));

    const result = await reindex(space.paths, index, space.logger);
    expect(result.linesRead).toBe(2);
    expect(result.duplicates).toBe(1);
    expect(index.count()).toBe(1);
    expect(index.get('a')?.likeCount).toBe(9);
  });

  it('reports and skips a line it cannot parse, keeping everything either side', async () => {
    write(makeCheckin({ id: 'a' }));
    appendFileSync(rawFileFor(space.paths, '2019-06-12'), '{"id":"torn","chec');
    write(makeCheckin({ id: 'b' }));

    const result = await reindex(space.paths, index, space.logger);
    expect(index.count()).toBe(2);
    expect(result.skipped).toHaveLength(1);
  });

  it('reports and skips a check-in that cannot be normalised', async () => {
    appendRaw(space.paths, [
      { id: 'nope', createdAt: 0, localDate: '2019-06-12', checkin: { notACheckin: true } },
    ]);
    const result = await reindex(space.paths, index, space.logger);
    expect(index.count()).toBe(0);
    expect(result.skipped[0]?.message).toMatch(/without an id/);
  });

  it('is a no-op on an archive with no raw files', async () => {
    const result = await reindex(space.paths, index, space.logger);
    expect(result).toMatchObject({ indexed: 0, linesRead: 0 });
  });

  it('crosses the batch boundary without losing rows', async () => {
    // The batch size is 500; 1200 exercises three flushes and a remainder.
    const many = Array.from({ length: 1200 }, (_unused, i) =>
      makeCheckin({ id: `bulk-${i}`, createdAt: BASE_CREATED_AT + i }),
    );
    write(...many);

    const result = await reindex(space.paths, index, space.logger);
    expect(result.indexed).toBe(1200);
    expect(index.count()).toBe(1200);
  });

  it('is idempotent', async () => {
    write(makeCheckin({ id: 'a' }), makeCheckin({ id: 'b' }));
    await reindex(space.paths, index, space.logger);
    const first = index.count();
    await reindex(space.paths, index, space.logger);
    expect(index.count()).toBe(first);
  });

  it('recovers rows the index lost but the raw files still hold', async () => {
    write(makeCheckin({ id: 'a' }), makeCheckin({ id: 'b' }));
    await reindex(space.paths, index, space.logger);

    // What a schema-version recreation leaves behind.
    index.clear();
    expect(index.count()).toBe(0);

    await reindex(space.paths, index, space.logger);
    expect(index.count()).toBe(2);
  });
});
