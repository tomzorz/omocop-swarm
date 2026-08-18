import { describe, expect, it } from 'vitest';
import {
  normaliseCheckin,
  photoUrl,
  searchableText,
  UnusableCheckinError,
} from '../../src/domain/checkin.js';
import { hostileCheckin, makeCheckin, sparseCheckin } from '../support/factory.js';

describe('normaliseCheckin', () => {
  it('reads every field off a fully populated check-in', () => {
    const { record } = normaliseCheckin(
      makeCheckin({ shout: 'first beer of the summer', photos: 2, friends: 3, likes: 4 }),
    );

    expect(record.id).toBe('checkin-1');
    expect(record.localDate).toBe('2019-06-12');
    expect(record.localTime).toBe('21:34');
    expect(record.venueName).toBe('Kisüzem');
    expect(record.city).toBe('Budapest');
    expect(record.countryCode).toBe('HU');
    expect(record.categoryName).toBe('Bar');
    expect(record.shout).toBe('first beer of the summer');
    expect(record.photoCount).toBe(2);
    expect(record.likeCount).toBe(4);
    expect(record.withCount).toBe(3);
    expect(record.sourceName).toBe('Swarm for iOS');
  });

  it('picks the primary category, not merely the first', () => {
    const raw = makeCheckin();
    const venue = raw['venue'] as Record<string, unknown>;
    const categories = venue['categories'] as Array<Record<string, unknown>>;
    // Reverse them: the primary flag must still decide.
    venue['categories'] = [categories[1], categories[0]];

    const { record } = normaliseCheckin(raw);
    expect(record.categoryName).toBe('Bar');
  });

  it('falls back to the first category when none is flagged primary', () => {
    const raw = makeCheckin();
    const venue = raw['venue'] as Record<string, unknown>;
    venue['categories'] = [{ id: 'x', name: 'Only One' }];

    const { record } = normaliseCheckin(raw);
    expect(record.categoryName).toBe('Only One');
  });

  it('survives a check-in with nothing but a venue name', () => {
    const { record, photos, categories, companions } = normaliseCheckin(sparseCheckin());
    expect(record.venueName).toBe('A place that went away');
    expect(record.lat).toBeUndefined();
    expect(record.categoryName).toBeUndefined();
    expect(record.photoCount).toBe(0);
    expect(photos).toEqual([]);
    expect(categories).toEqual([]);
    expect(companions).toEqual([]);
  });

  it('survives fields of entirely the wrong type without throwing', () => {
    const { record } = normaliseCheckin(hostileCheckin());
    expect(record.id).toBe('hostile-1');
    expect(record.venueName).toBeUndefined();
    expect(record.photoCount).toBe(0);
    expect(record.withCount).toBe(0);
    // A shout that arrived as a number is still readable as text.
    expect(record.shout).toBe('42');
  });

  it('treats a missing timezone offset as UTC rather than guessing the host', () => {
    const raw = makeCheckin();
    delete raw['timeZoneOffset'];
    const { record } = normaliseCheckin(raw);
    expect(record.tzOffset).toBe(0);
    expect(record.localTime).toBe('19:34');
  });

  it('throws only when the id or createdAt is missing', () => {
    expect(() => normaliseCheckin({ createdAt: 1 })).toThrow(UnusableCheckinError);
    expect(() => normaliseCheckin({ id: 'x' })).toThrow(UnusableCheckinError);
    expect(() => normaliseCheckin({ id: 'x', createdAt: 1 })).not.toThrow();
  });

  it('names the check-in in the error, so a broken sync says which one', () => {
    expect(() => normaliseCheckin({ id: 'checkin-42' })).toThrow(/checkin-42/);
  });

  it('gives photos without ids a stable addressable key', () => {
    const raw = makeCheckin({ photos: 2 });
    const photoBag = raw['photos'] as Record<string, unknown>;
    const items = photoBag['items'] as Array<Record<string, unknown>>;
    delete items[0]?.['id'];

    const { photos } = normaliseCheckin(raw);
    expect(photos[0]?.photoId).toBe('checkin-1#0');
    expect(photos[1]?.photoId).toBe('photo-1');
  });

  it('counts an envelope by its items when count is missing', () => {
    const raw = makeCheckin({ photos: 3 });
    delete (raw['photos'] as Record<string, unknown>)['count'];
    expect(normaliseCheckin(raw).record.photoCount).toBe(3);
  });

  it('records every category, not only the primary', () => {
    const { categories } = normaliseCheckin(makeCheckin());
    expect(categories.map((category) => category.name)).toEqual(['Bar', 'Pub']);
    expect(categories.filter((category) => category.isPrimary)).toHaveLength(1);
  });
});

describe('photoUrl', () => {
  it('reassembles the two halves around a size', () => {
    const { photos } = normaliseCheckin(makeCheckin({ photos: 1 }));
    expect(photoUrl(photos[0]!)).toBe(
      'https://fastly.4sqi.net/img/general/original/12345_photo0.jpg',
    );
    expect(photoUrl(photos[0]!, '300x300')).toContain('/300x300/');
  });

  it('returns nothing when a half is missing', () => {
    expect(
      photoUrl({
        checkinId: 'c',
        photoId: 'p',
        prefix: undefined,
        suffix: '.jpg',
        width: undefined,
        height: undefined,
        createdAt: undefined,
      }),
    ).toBeUndefined();
  });
});

describe('searchableText', () => {
  it('gathers the fields worth searching and drops the empty ones', () => {
    const { record } = normaliseCheckin(makeCheckin({ shout: 'best langos' }));
    const text = searchableText(record);
    expect(text).toContain('best langos');
    expect(text).toContain('Kisüzem');
    expect(text).toContain('Budapest');
    expect(text).toContain('Bar');
    expect(text).not.toContain('undefined');
  });

  it('is empty for a check-in with nothing to say', () => {
    const { record } = normaliseCheckin({ id: 'x', createdAt: 1 });
    expect(searchableText(record)).toBe('');
  });
});
