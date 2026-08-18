/**
 * Time, in the only frame that makes sense for a check-in.
 *
 * A check-in carries `createdAt` (Unix seconds, UTC) and `timeZoneOffset` (the
 * venue's offset from UTC in minutes, at that instant). The offset is the
 * valuable half: it is the only record of what the clock on the wall said where
 * you actually were. Rendering a 2014 check-in in Tokyo through the archive
 * machine's current timezone produces a time that never happened to anybody.
 *
 * The whole file rests on one move: add the offset to the UTC instant and read
 * the result as though it were UTC. The arithmetic is then plain, no timezone
 * database is consulted, and historical DST is automatically right because the
 * offset was recorded at the time rather than re-derived now.
 *
 *     createdAt (UTC)      1467324000  ->  2016-06-30 22:00 UTC
 *     timeZoneOffset       +120 min
 *     localTs              1467331200  ->  read as UTC: 2016-07-01 00:00
 *                                          which is the wall clock in Budapest
 *
 * `localTs` is therefore not an instant. It is a wall clock encoded as a
 * number, and it is only ever compared against other wall clocks. Nothing may
 * hand it to something expecting a real timestamp.
 */

const DAY_SECONDS = 86_400;

export interface LocalStamp {
  /** Wall clock encoded as seconds. Never an instant — see the file comment. */
  readonly localTs: number;
  /** Calendar date at the venue, `YYYY-MM-DD`. */
  readonly date: string;
  /** Wall-clock time at the venue, `HH:MM`. */
  readonly time: string;
  /** 0 = Sunday, matching `Date.prototype.getUTCDay`. */
  readonly weekday: number;
}

/** Projects a UTC instant into the venue's wall clock. */
export function localStamp(createdAt: number, timeZoneOffsetMinutes: number): LocalStamp {
  const localTs = createdAt + timeZoneOffsetMinutes * 60;
  const asDate = new Date(localTs * 1000);
  return {
    localTs,
    date: asDate.toISOString().slice(0, 10),
    time: asDate.toISOString().slice(11, 16),
    weekday: asDate.getUTCDay(),
  };
}

/**
 * Parses `YYYY-MM-DD` into the wall clock at midnight.
 *
 * V8 accepts an ISO date with an out-of-range day and silently rolls it over —
 * `2025-02-30` parses happily as 2 March — so a NaN check does not validate a
 * date. Round-tripping the parsed value back to a string does, because a rolled
 * date never renders as what was typed.
 *
 * @throws Error naming the input when it is not a real calendar date
 */
export function parseDate(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`"${date}" is not a date. Expected YYYY-MM-DD.`);
  }
  const parsed = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed)) throw new Error(`"${date}" is not a real calendar date.`);
  const roundTrip = new Date(parsed).toISOString().slice(0, 10);
  if (roundTrip !== date) {
    throw new Error(`"${date}" is not a real calendar date (it would mean ${roundTrip}).`);
  }
  return parsed / 1000;
}

/** Renders a wall clock back to `YYYY-MM-DD`. */
export const formatDate = (localTs: number): string =>
  new Date(localTs * 1000).toISOString().slice(0, 10);

export interface Window {
  /** Inclusive lower bound, as a wall clock. */
  readonly from: number;
  /** Exclusive upper bound, as a wall clock. */
  readonly to: number;
}

/**
 * The half-open wall-clock window for a run of days.
 *
 * `dayStartHour` moves the boundary off midnight. At 6 a check-in at 02:00 on
 * Saturday falls inside Friday's window, which is what somebody asking "where
 * was I on Friday" means by it — the night out did not become a different day
 * because a clock rolled over mid-drink.
 *
 * @param from first day, `YYYY-MM-DD`
 * @param to last day, inclusive, `YYYY-MM-DD`; defaults to `from`
 * @throws Error when either date is malformed, or the range runs backwards
 */
export function dayWindow(from: string, to: string = from, dayStartHour = 0): Window {
  const start = parseDate(from);
  const end = parseDate(to);
  if (end < start) {
    throw new Error(`The range runs backwards: ${from} is after ${to}.`);
  }
  const shift = dayStartHour * 3600;
  return { from: start + shift, to: end + DAY_SECONDS + shift };
}

/**
 * The day a check-in belongs to under a shifted boundary.
 *
 * Distinct from `LocalStamp.date`, which is always the true calendar date. With
 * `dayStartHour` at 6, a 02:00 check-in has date 2016-07-02 and journal day
 * 2016-07-01, and both are worth being able to ask for.
 */
export const journalDate = (localTs: number, dayStartHour = 0): string =>
  formatDate(localTs - dayStartHour * 3600);

/** Renders a duration in whole units, for progress and summary lines. */
export function humanDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < DAY_SECONDS) return `${(seconds / 3600).toFixed(1)}h`;
  return `${Math.round(seconds / DAY_SECONDS)}d`;
}
