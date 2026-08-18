import { appendFileSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendRaw, rawFiles, readRaw, type ReadProblem } from '../../src/store/raw.js';
import { rawFileFor } from '../../src/store/paths.js';
import { workspace, type Workspace } from '../support/factory.js';

let space: Workspace;

beforeEach(() => {
  space = workspace();
});
afterEach(() => {
  space.cleanup();
});

const collect = async (onProblem?: (problem: ReadProblem) => void) => {
  const entries = [];
  for await (const entry of readRaw(space.paths, onProblem)) entries.push(entry);
  return entries;
};

describe('appendRaw', () => {
  it('writes each check-in into the file for its venue-local month', () => {
    appendRaw(space.paths, [
      { id: 'a', createdAt: 1, localDate: '2019-06-12', checkin: { id: 'a' } },
      { id: 'b', createdAt: 2, localDate: '2019-06-30', checkin: { id: 'b' } },
      { id: 'c', createdAt: 3, localDate: '2019-07-01', checkin: { id: 'c' } },
    ]);

    expect(rawFiles(space.paths).map((file) => file.split(/[\\/]/).pop())).toEqual([
      'checkins-2019-06.jsonl',
      'checkins-2019-07.jsonl',
    ]);
    expect(readFileSync(rawFileFor(space.paths, '2019-06-12'), 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('appends rather than replacing, across calls', () => {
    appendRaw(space.paths, [{ id: 'a', createdAt: 1, localDate: '2019-06-12', checkin: { id: 'a' } }]);
    appendRaw(space.paths, [{ id: 'b', createdAt: 2, localDate: '2019-06-13', checkin: { id: 'b' } }]);
    expect(readFileSync(rawFileFor(space.paths, '2019-06-01'), 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('stores the check-in verbatim, including fields nothing reads', () => {
    const exotic = { id: 'a', createdAt: 1, somethingNobodyModelled: { deeply: ['nested', 1, null] } };
    appendRaw(space.paths, [{ id: 'a', createdAt: 1, localDate: '2019-06-12', checkin: exotic }]);

    const line = JSON.parse(readFileSync(rawFileFor(space.paths, '2019-06-12'), 'utf8').trim());
    expect(line.checkin).toEqual(exotic);
  });

  it('writes nothing for an empty batch', () => {
    expect(appendRaw(space.paths, [])).toBe(0);
    expect(rawFiles(space.paths)).toEqual([]);
  });
});

describe('readRaw', () => {
  it('is empty when nothing has been written', async () => {
    expect(await collect()).toEqual([]);
  });

  it('round-trips what was appended, oldest month first', async () => {
    appendRaw(space.paths, [
      { id: 'july', createdAt: 3, localDate: '2019-07-01', checkin: { id: 'july' } },
      { id: 'june', createdAt: 1, localDate: '2019-06-12', checkin: { id: 'june' } },
    ]);

    const entries = await collect();
    expect(entries.map((entry) => entry.id)).toEqual(['june', 'july']);
    expect(entries[0]?.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('skips a torn final line and keeps everything before it', async () => {
    appendRaw(space.paths, [
      { id: 'a', createdAt: 1, localDate: '2019-06-12', checkin: { id: 'a' } },
      { id: 'b', createdAt: 2, localDate: '2019-06-12', checkin: { id: 'b' } },
    ]);
    // What an interrupted append leaves behind.
    appendFileSync(rawFileFor(space.paths, '2019-06-12'), '{"id":"c","createdAt":3,"chec');

    const problems: ReadProblem[] = [];
    const entries = await collect((problem) => problems.push(problem));

    expect(entries.map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.line).toBe(3);
  });

  it('isolates a torn line so a later append is not glued onto it', async () => {
    // The dangerous sequence: crash mid-append, then a successful sync appends
    // more. Without a separator the next check-in joins the fragment and is
    // lost from the raw archive while still being in the index — invisible
    // until a reindex silently drops it.
    appendRaw(space.paths, [{ id: 'a', createdAt: 1, localDate: '2019-06-12', checkin: { id: 'a' } }]);
    appendFileSync(rawFileFor(space.paths, '2019-06-12'), '{"id":"torn","chec');
    appendRaw(space.paths, [{ id: 'b', createdAt: 2, localDate: '2019-06-12', checkin: { id: 'b' } }]);

    const problems: ReadProblem[] = [];
    const entries = await collect((problem) => problems.push(problem));

    expect(entries.map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(problems).toHaveLength(1);
  });

  it('skips a line that parses but is not a raw entry', async () => {
    appendFileSync(rawFileFor(space.paths, '2019-06-12'), '{"hello":"world"}\n');
    const problems: ReadProblem[] = [];
    expect(await collect((problem) => problems.push(problem))).toEqual([]);
    expect(problems[0]?.message).toMatch(/not a raw check-in entry/);
  });

  it('ignores blank lines', async () => {
    appendRaw(space.paths, [{ id: 'a', createdAt: 1, localDate: '2019-06-12', checkin: { id: 'a' } }]);
    appendFileSync(rawFileFor(space.paths, '2019-06-12'), '\n\n');
    const problems: ReadProblem[] = [];
    expect(await collect((problem) => problems.push(problem))).toHaveLength(1);
    expect(problems).toEqual([]);
  });

  it('keeps both copies when a check-in is written twice', async () => {
    appendRaw(space.paths, [{ id: 'a', createdAt: 1, localDate: '2019-06-12', checkin: { likes: 1 } }]);
    appendRaw(space.paths, [{ id: 'a', createdAt: 1, localDate: '2019-06-12', checkin: { likes: 9 } }]);

    const entries = await collect();
    expect(entries).toHaveLength(2);
    expect(entries[1]?.checkin).toEqual({ likes: 9 });
  });
});
