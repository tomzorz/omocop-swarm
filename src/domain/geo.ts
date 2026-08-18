/**
 * Distance and bounding boxes, in plain arithmetic.
 *
 * A radius query runs in two stages on purpose. SQLite gets a bounding box,
 * which an index on (lat, lng) can actually use; the exact circle is then cut
 * in JavaScript over the handful of rows that survived. Doing the trigonometry
 * in SQL would work and would also read every row in the table, because no
 * index can help with a haversine in the WHERE clause.
 */

const EARTH_RADIUS_M = 6_371_008.8;
const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

export interface Point {
  readonly lat: number;
  readonly lng: number;
}

/**
 * Great-circle distance in metres.
 *
 * Haversine treats the Earth as a sphere, so it is off by up to ~0.5% against
 * the true ellipsoid. At the scale anyone asks a check-in archive about — "what
 * did I visit within 500m of here" — that is metres, and not worth the cost of
 * Vincenty's iteration.
 */
export function distanceMeters(a: Point, b: Point): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface BoundingBox {
  readonly minLat: number;
  readonly maxLat: number;
  readonly minLng: number;
  readonly maxLng: number;
}

/**
 * The smallest axis-aligned box containing every point within `radiusMeters`.
 *
 * Two edge cases are handled by widening rather than by wrapping, because a
 * wrapped box needs an OR in the SQL and an OR over two ranges is where index
 * usage quietly stops. Both cases produce a box that is too big and never one
 * that is too small, and the exact distance check afterwards removes the
 * surplus — so the result is correct either way, just less selective.
 *
 *   - Crossing the antimeridian (a radius around Fiji): longitude opens to the
 *     full range.
 *   - Crossing a pole: longitude opens to the full range, because every
 *     meridian is within the radius.
 */
export function boundingBox(centre: Point, radiusMeters: number): BoundingBox {
  const latDelta = (radiusMeters / EARTH_RADIUS_M) * (180 / Math.PI);
  const minLat = centre.lat - latDelta;
  const maxLat = centre.lat + latDelta;

  if (minLat <= -90 || maxLat >= 90) {
    return {
      minLat: Math.max(-90, minLat),
      maxLat: Math.min(90, maxLat),
      minLng: -180,
      maxLng: 180,
    };
  }

  // The parallels bounding the box converge towards the poles, so the widest
  // longitude span is at whichever edge is closer to a pole.
  const widest = Math.max(Math.abs(minLat), Math.abs(maxLat));
  const lngDelta = latDelta / Math.cos(toRadians(widest));
  const minLng = centre.lng - lngDelta;
  const maxLng = centre.lng + lngDelta;

  if (minLng < -180 || maxLng > 180) {
    return { minLat, maxLat, minLng: -180, maxLng: 180 };
  }

  return { minLat, maxLat, minLng, maxLng };
}

/** Rejects coordinates that cannot exist, before they reach a query. */
export function assertPoint(point: Point, label = 'coordinate'): void {
  if (!Number.isFinite(point.lat) || point.lat < -90 || point.lat > 90) {
    throw new Error(`${label} latitude must be between -90 and 90, got ${point.lat}.`);
  }
  if (!Number.isFinite(point.lng) || point.lng < -180 || point.lng > 180) {
    throw new Error(`${label} longitude must be between -180 and 180, got ${point.lng}.`);
  }
}
