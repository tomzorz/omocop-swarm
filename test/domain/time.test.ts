import { describe, expect, it } from 'vitest';
import {
  dayWindow,
  formatDate,
  humanDuration,
  journalDate,
  localStamp,
  parseDate,
} from '../../src/domain/time.js';

describe('localStamp', () => {
  it('reads the wall clock where the check-in happened, not where the archive is', () => {
    // 2019-06-12 19:34 UTC, in a +02:00 zone.
    const stamp = localStamp(1_560_368_040, 120);
    expect(stamp.date).toBe('2019-06-12');
    expect(stamp.time).toBe('21:34');
  });

  it('handles a negative offset across the date line', () => {
    // 2019-06-12 02:00 UTC in UTC-5 is the previous evening.
    const stamp = localStamp(Date.parse('2019-06-12T02:00:00Z') / 1000, -300);
    expect(stamp.date).toBe('2019-06-11');
    expect(stamp.time).toBe('21:00');
  });

  it('handles a far-eastern offset across the other date line', () => {
    const stamp = localStamp(Date.parse('2019-06-12T22:00:00Z') / 1000, 780);
    expect(stamp.date).toBe('2019-06-13');
    expect(stamp.time).toBe('11:00');
  });

  it('reports the weekday of the local date, not the UTC one', () => {
    // Sunday 23:00 UTC is Monday in +02:00.
    const stamp = localStamp(Date.parse('2019-06-09T23:00:00Z') / 1000, 120);
    expect(stamp.date).toBe('2019-06-10');
    expect(stamp.weekday).toBe(1);
  });

  it('uses the historical offset it was given rather than any current rule', () => {
    // Same instant, two different recorded offsets: both are honoured verbatim.
    const winter = localStamp(1_560_368_040, 60);
    const summer = localStamp(1_560_368_040, 120);
    expect(winter.time).toBe('20:34');
    expect(summer.time).toBe('21:34');
  });
});

describe('parseDate', () => {
  it('accepts a real date', () => {
    expect(parseDate('2019-06-12')).toBe(Date.parse('2019-06-12T00:00:00Z') / 1000);
  });

  it.each(['2019-6-12', '12/06/2019', 'yesterday', '2019-06'])('rejects %s', (input) => {
    expect(() => parseDate(input)).toThrow(/not a date/);
  });

  it('rejects a day that does not exist, which V8 would silently roll over', () => {
    // Date.parse('2025-02-30T00:00:00Z') is not NaN — it is 2 March. A NaN check
    // would pass this through, so the round trip is what actually validates.
    expect(() => parseDate('2025-02-30')).toThrow(/would mean 2025-03-02/);
  });

  it('rejects an impossible month', () => {
    expect(() => parseDate('2025-13-01')).toThrow(/not a real calendar date/);
  });

  it('accepts a leap day in a leap year and rejects it otherwise', () => {
    expect(() => parseDate('2024-02-29')).not.toThrow();
    expect(() => parseDate('2025-02-29')).toThrow();
  });
});

describe('dayWindow', () => {
  it('covers exactly one day when only a start is given', () => {
    const window = dayWindow('2019-06-12');
    expect(formatDate(window.from)).toBe('2019-06-12');
    expect(window.to - window.from).toBe(86_400);
  });

  it('is half-open, so a check-in at midnight belongs to the later day only', () => {
    const first = dayWindow('2019-06-12');
    const second = dayWindow('2019-06-13');
    expect(first.to).toBe(second.from);
  });

  it('covers an inclusive range', () => {
    const window = dayWindow('2019-06-01', '2019-06-30');
    expect(window.to - window.from).toBe(30 * 86_400);
  });

  it('shifts both edges when the day starts later', () => {
    const window = dayWindow('2019-06-12', '2019-06-12', 6);
    expect(window.from).toBe(parseDate('2019-06-12') + 6 * 3600);
    expect(window.to).toBe(parseDate('2019-06-13') + 6 * 3600);
  });

  it('puts a 02:00 check-in in the previous day when the day starts at 06:00', () => {
    const lateNight = localStamp(Date.parse('2019-06-13T00:00:00Z') / 1000, 120); // 02:00 local
    expect(lateNight.date).toBe('2019-06-13');

    const friday = dayWindow('2019-06-12', '2019-06-12', 6);
    expect(lateNight.localTs).toBeGreaterThanOrEqual(friday.from);
    expect(lateNight.localTs).toBeLessThan(friday.to);
  });

  it('refuses a range that runs backwards', () => {
    expect(() => dayWindow('2019-06-30', '2019-06-01')).toThrow(/backwards/);
  });
});

describe('journalDate', () => {
  it('is the calendar date when the day starts at midnight', () => {
    const stamp = localStamp(Date.parse('2019-06-13T00:00:00Z') / 1000, 120);
    expect(journalDate(stamp.localTs, 0)).toBe('2019-06-13');
  });

  it('is the previous date for the small hours when the day starts later', () => {
    const stamp = localStamp(Date.parse('2019-06-13T00:00:00Z') / 1000, 120);
    expect(journalDate(stamp.localTs, 6)).toBe('2019-06-12');
  });

  it('leaves an afternoon alone', () => {
    const stamp = localStamp(Date.parse('2019-06-13T12:00:00Z') / 1000, 120);
    expect(journalDate(stamp.localTs, 6)).toBe('2019-06-13');
  });
});

describe('humanDuration', () => {
  it.each([
    [12, '12s'],
    [300, '5m'],
    [7200, '2.0h'],
    [172_800, '2d'],
  ])('renders %d seconds as %s', (seconds, expected) => {
    expect(humanDuration(seconds)).toBe(expected);
  });
});
