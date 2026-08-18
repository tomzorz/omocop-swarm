import { writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  capabilitiesValid,
  EMPTY_STATE,
  readState,
  writeState,
} from '../../src/store/state.js';
import { workspace, type Workspace } from '../support/factory.js';

let space: Workspace;

beforeEach(() => {
  space = workspace();
});
afterEach(() => {
  space.cleanup();
});

describe('readState', () => {
  it('is empty when no file exists', () => {
    expect(readState(space.paths)).toEqual(EMPTY_STATE);
  });

  it('round-trips a written state', () => {
    const state = {
      ...EMPTY_STATE,
      newest: { id: 'a', createdAt: 100 },
      backfill: { complete: true, offset: 750 },
      remoteCount: 750,
    };
    writeState(space.paths, state);
    expect(readState(space.paths)).toMatchObject(state);
  });

  it('falls back to empty and warns when the file is not JSON', () => {
    writeFileSync(space.paths.statePath, 'not json at all');
    const warnings: string[] = [];
    expect(readState(space.paths, (warning) => warnings.push(warning))).toEqual(EMPTY_STATE);
    expect(warnings[0]).toMatch(/not valid JSON/);
  });

  it('falls back to empty and warns when the shape is wrong', () => {
    writeFileSync(space.paths.statePath, JSON.stringify({ version: 99, backfill: 'yes' }));
    const warnings: string[] = [];
    expect(readState(space.paths, (warning) => warnings.push(warning))).toEqual(EMPTY_STATE);
    expect(warnings[0]).toMatch(/does not match the expected shape/);
  });

  it('applies defaults to a state written by an older run', () => {
    writeFileSync(space.paths.statePath, JSON.stringify({ version: 1 }));
    const state = readState(space.paths);
    expect(state.backfill).toEqual({ complete: false, offset: 0 });
  });
});

describe('writeState', () => {
  it('leaves no temp file behind', () => {
    writeState(space.paths, EMPTY_STATE);
    expect(() => readState(space.paths)).not.toThrow();
    // The rename is what makes the write atomic; a leftover .tmp would mean it
    // did not happen.
    expect(readState(space.paths)).toEqual(EMPTY_STATE);
  });
});

describe('capabilitiesValid', () => {
  const capabilities = {
    afterTimestamp: true,
    beforeTimestamp: false,
    sortOldestFirst: true,
    probedAt: '2026-01-01T00:00:00.000Z',
    apiVersion: '20250401',
  };

  it('accepts a verdict probed under the same API version', () => {
    expect(capabilitiesValid(capabilities, '20250401')).toBe(true);
  });

  it('rejects one probed under a different version, which may behave differently', () => {
    expect(capabilitiesValid(capabilities, '20260101')).toBe(false);
  });

  it('rejects an absent verdict', () => {
    expect(capabilitiesValid(undefined, '20250401')).toBe(false);
  });
});
