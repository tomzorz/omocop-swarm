import { describe, expect, it } from 'vitest';
import { assertPoint, boundingBox, distanceMeters } from '../../src/domain/geo.js';

const BUDAPEST = { lat: 47.4979, lng: 19.0402 };
const VIENNA = { lat: 48.2082, lng: 16.3738 };

describe('distanceMeters', () => {
  it('is zero for a point against itself', () => {
    expect(distanceMeters(BUDAPEST, BUDAPEST)).toBe(0);
  });

  it('matches the known Budapest–Vienna great-circle distance', () => {
    // ~214 km. Haversine's spherical assumption is worth up to ~0.5%, so the
    // tolerance is set at 1% rather than pretending to more precision.
    const distance = distanceMeters(BUDAPEST, VIENNA);
    expect(distance).toBeGreaterThan(212_000);
    expect(distance).toBeLessThan(216_000);
  });

  it('is symmetric', () => {
    expect(distanceMeters(BUDAPEST, VIENNA)).toBeCloseTo(distanceMeters(VIENNA, BUDAPEST), 6);
  });

  it('measures a degree of latitude at about 111 km anywhere', () => {
    const atEquator = distanceMeters({ lat: 0, lng: 0 }, { lat: 1, lng: 0 });
    const upNorth = distanceMeters({ lat: 60, lng: 30 }, { lat: 61, lng: 30 });
    expect(atEquator).toBeCloseTo(111_195, -2);
    expect(upNorth).toBeCloseTo(111_195, -2);
  });

  it('handles the shortest way round the antimeridian', () => {
    const distance = distanceMeters({ lat: 0, lng: 179.5 }, { lat: 0, lng: -179.5 });
    // One degree of longitude at the equator, not 359 of them.
    expect(distance).toBeLessThan(120_000);
  });
});

describe('boundingBox', () => {
  it('contains the centre', () => {
    const box = boundingBox(BUDAPEST, 500);
    expect(BUDAPEST.lat).toBeGreaterThan(box.minLat);
    expect(BUDAPEST.lat).toBeLessThan(box.maxLat);
    expect(BUDAPEST.lng).toBeGreaterThan(box.minLng);
    expect(BUDAPEST.lng).toBeLessThan(box.maxLng);
  });

  it('never excludes a point inside the radius', () => {
    const radius = 1_000;
    const box = boundingBox(BUDAPEST, radius);
    // Sample the circle; every point on it must be inside the box, or the
    // two-stage query would drop results the exact filter would have kept.
    for (let bearing = 0; bearing < 360; bearing += 5) {
      const radians = (bearing * Math.PI) / 180;
      const latDelta = (radius / 6_371_008.8) * (180 / Math.PI) * Math.cos(radians);
      const lngDelta =
        ((radius / 6_371_008.8) * (180 / Math.PI) * Math.sin(radians)) /
        Math.cos((BUDAPEST.lat * Math.PI) / 180);
      const point = { lat: BUDAPEST.lat + latDelta, lng: BUDAPEST.lng + lngDelta };
      expect(point.lat).toBeGreaterThanOrEqual(box.minLat);
      expect(point.lat).toBeLessThanOrEqual(box.maxLat);
      expect(point.lng).toBeGreaterThanOrEqual(box.minLng);
      expect(point.lng).toBeLessThanOrEqual(box.maxLng);
    }
  });

  it('is wider in longitude than in latitude away from the equator', () => {
    const box = boundingBox(BUDAPEST, 1_000);
    expect(box.maxLng - box.minLng).toBeGreaterThan(box.maxLat - box.minLat);
  });

  it('opens longitude fully rather than wrapping across the antimeridian', () => {
    const box = boundingBox({ lat: -17.7, lng: 179.9 }, 50_000);
    expect(box.minLng).toBe(-180);
    expect(box.maxLng).toBe(180);
  });

  it('opens longitude fully and clamps latitude near a pole', () => {
    const box = boundingBox({ lat: 89.9, lng: 0 }, 100_000);
    expect(box.maxLat).toBeLessThanOrEqual(90);
    expect(box.minLng).toBe(-180);
    expect(box.maxLng).toBe(180);
  });
});

describe('assertPoint', () => {
  it('accepts the extremes', () => {
    expect(() => assertPoint({ lat: -90, lng: 180 })).not.toThrow();
  });

  it.each([
    [{ lat: 91, lng: 0 }, /latitude/],
    [{ lat: 0, lng: 181 }, /longitude/],
    [{ lat: Number.NaN, lng: 0 }, /latitude/],
  ])('rejects %o', (point, pattern) => {
    expect(() => assertPoint(point)).toThrow(pattern);
  });
});
