/**
 * The query tools, end to end through the real harness and a real archive.
 *
 * These go through `runTool`, so they exercise the requirement gate, the output
 * schema validation and the renderer as well as the handler — which is the
 * whole point, since the rendered prose is what a model and a shell user both
 * actually read.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../../src/config.js';
import { FoursquareClient } from '../../src/foursquare/client.js';
import { runTool, type ToolContext } from '../../src/server/tool.js';
import { Archive } from '../../src/store/archive.js';
import { normaliseCheckin } from '../../src/domain/checkin.js';
import { allTools } from '../../src/tools/all.js';
import { TokenStore } from '../../src/auth/token-store.js';
import { BASE_CREATED_AT, makeCheckin, workspace, type Workspace } from '../support/factory.js';
import { FakeFoursquare } from '../support/fake-foursquare.js';

let space: Workspace;
let archive: Archive;
let config: Config;

const tool = (name: string) => {
  const store = new TokenStore(config, space.logger, space.paths.tokenPath);
  const found = allTools(store).find((definition) => definition.name === name);
  if (!found) throw new Error(`no tool named ${name}`);
  return found;
};

const call = async (name: string, args: Record<string, unknown> = {}, foursquare?: FakeFoursquare) => {
  const definition = tool(name);
  const parsed = (await import('zod')).z.object(definition.input).parse(args);
  const context: ToolContext = {
    archive,
    api: foursquare
      ? new FoursquareClient({
          endpoint: 'https://api.foursquare.com/v2/',
          apiVersion: '20250401',
          token: 'test-token',
          logger: space.logger,
          fetchImpl: foursquare.fetch,
        })
      : undefined,
    config,
    logger: space.logger,
    resolved: new Map(),
  };
  return runTool(definition, parsed as never, context);
};

const text = (result: { content: ReadonlyArray<{ text: string }> }): string =>
  result.content.map((block) => block.text).join('\n');

beforeEach(() => {
  space = workspace();
  config = loadConfig({ SWARM_DATA_DIR: space.dir });
  archive = Archive.open(config, space.logger);

  const raws = [
    makeCheckin({ id: 'a', createdAt: BASE_CREATED_AT, shout: 'best langos', photos: 2 }),
    makeCheckin({
      id: 'b',
      createdAt: BASE_CREATED_AT + 86_400,
      venueName: 'Espresso Embassy',
      venueId: 'venue-2',
      category: 'Cafe',
      lat: 47.5,
      lng: 19.06,
    }),
    makeCheckin({
      id: 'c',
      createdAt: BASE_CREATED_AT + 172_800,
      venueName: 'Berghain',
      venueId: 'venue-3',
      city: 'Berlin',
      cc: 'DE',
      country: 'Germany',
      lat: 52.511,
      lng: 13.443,
      friends: 2,
    }),
  ];
  archive.index.upsert(
    raws.map((raw) => ({ normalised: normaliseCheckin(raw), rawJson: JSON.stringify(raw) })),
  );
});

afterEach(() => {
  archive.close();
  space.cleanup();
});

describe('list-checkins', () => {
  it('lists everything newest first', async () => {
    const result = await call('list-checkins');
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.['total']).toBe(3);
    expect(text(result)).toContain('Berghain');
  });

  it('answers a single-day question', async () => {
    const result = await call('list-checkins', { from: '2019-06-12' });
    expect(result.structuredContent?.['total']).toBe(1);
    expect(text(result)).toContain('on 2019-06-12');
    expect(text(result)).toContain('Kisüzem');
  });

  it('renders the place, the time and the marks on one line', async () => {
    const rendered = text(await call('list-checkins', { from: '2019-06-12' }));
    expect(rendered).toContain('2019-06-12 21:34');
    expect(rendered).toContain('Bar, Budapest HU');
    expect(rendered).toContain('"best langos"');
    expect(rendered).toContain('2 photos');
  });

  it('says so plainly when nothing matches', async () => {
    const rendered = text(await call('list-checkins', { from: '1999-01-01' }));
    expect(rendered).toMatch(/No check-ins on 1999-01-01/);
  });

  it('reports the total separately from the page', async () => {
    const result = await call('list-checkins', { limit: 1 });
    expect(result.structuredContent?.['total']).toBe(3);
    expect(text(result)).toContain('1 of 3');
  });

  it('rejects a malformed date at the schema, before any query runs', async () => {
    const definition = tool('list-checkins');
    const { z } = await import('zod');
    expect(() => z.object(definition.input).parse({ from: '12/06/2019' })).toThrow(/YYYY-MM-DD/);
  });
});

describe('get-checkin', () => {
  it('returns the full detail with photo links', async () => {
    const result = await call('get-checkin', { id: 'a' });
    expect(result.structuredContent?.['found']).toBe(true);
    const rendered = text(result);
    expect(rendered).toContain('Wednesday 2019-06-12');
    expect(rendered).toContain('https://fastly.4sqi.net/img/general/original/');
    expect(rendered).toContain('metadata, not the images');
  });

  it('lists who you were with', async () => {
    expect(text(await call('get-checkin', { id: 'c' }))).toContain('With: Friend 0, Friend 1');
  });

  it('omits the raw object unless asked', async () => {
    expect((await call('get-checkin', { id: 'a' })).structuredContent?.['raw']).toBeNull();
    expect(
      (await call('get-checkin', { id: 'a', includeRaw: true })).structuredContent?.['raw'],
    ).toBeTruthy();
  });

  it('answers an unknown id without an error result', async () => {
    const result = await call('get-checkin', { id: 'nope' });
    expect(result.isError).toBeUndefined();
    expect(text(result)).toMatch(/No check-in with that id/);
  });
});

describe('search-checkins', () => {
  it('finds by a word in a shout', async () => {
    expect(text(await call('search-checkins', { query: 'langos' }))).toContain('Kisüzem');
  });

  it('does not fall over on FTS operators', async () => {
    const result = await call('search-checkins', { query: 'a OR "b -c' });
    expect(result.isError).toBeUndefined();
  });
});

describe('list-venues and breakdowns', () => {
  it('ranks venues', async () => {
    const rendered = text(await call('list-venues'));
    expect(rendered).toContain('1x');
    expect(rendered).toContain('Kisüzem');
  });

  it('enumerates the places visited somewhere, rather than ranking them', async () => {
    // "What places did I visit in Berlin" — the answer is a list, and ordering
    // it by frequency buries a one-off under anything slept in twice.
    const result = await call('list-venues', { city: 'Berlin', sort: 'recent' });
    const venues = result.structuredContent?.['venues'] as Array<{ label: string }>;
    expect(venues.map((venue) => venue.label)).toEqual(['Berghain']);
    expect(text(result)).toContain('Berlin');
  });

  it('carries the category and place onto each venue line', async () => {
    expect(text(await call('list-venues', { city: 'Berlin' }))).toMatch(/Berghain.*Berlin DE/);
  });

  it('groups by a dimension', async () => {
    const rendered = text(await call('checkin-breakdown', { by: 'city' }));
    expect(rendered).toContain('Budapest');
    expect(rendered).toContain('Berlin');
  });

  it('summarises with a histogram', async () => {
    const rendered = text(await call('checkin-stats'));
    expect(rendered).toContain('3 check-ins from 2019-06-12 to 2019-06-14');
    expect(rendered).toContain('2 cities');
    // Irregular plurals, and the singular case that reads wrong by default.
    expect(text(await call('checkin-stats', { city: 'Berlin' }))).toContain(
      '1 venue, 1 city, 1 country',
    );
    expect(rendered).toMatch(/Busiest day: \w+day/);
    expect(rendered).toContain('#');
  });
});

describe('last-visit', () => {
  it('answers "when did I last go to a place of this kind"', async () => {
    const result = await call('last-visit', { category: 'Cafe' });
    expect(result.structuredContent?.['found']).toBe(true);
    expect(result.structuredContent?.['visits']).toBe(1);
    const rendered = text(result);
    expect(rendered).toContain('2019-06-13');
    expect(rendered).toContain('Espresso Embassy');
  });

  it('reports first and last separately when they differ', async () => {
    const result = await call('last-visit', { city: 'Budapest' });
    expect(result.structuredContent?.['visits']).toBe(2);
    const rendered = text(result);
    expect(rendered).toMatch(/^Last/m);
    expect(rendered).toMatch(/^First:/m);
    expect(rendered).toContain('2 visits in total');
  });

  it('does not repeat itself when there is only one visit', async () => {
    const rendered = text(await call('last-visit', { city: 'Berlin' }));
    expect(rendered).not.toMatch(/^First:/m);
    expect(rendered).toContain('1 visit in total');
  });

  it('says how long ago, measured from the real instant', async () => {
    const result = await call('last-visit', { city: 'Berlin' });
    const days = result.structuredContent?.['daysSinceLast'] as number;
    // The fixture is from 2019; any sane clock puts this in the thousands.
    expect(days).toBeGreaterThan(1000);
    expect(text(result)).toMatch(/ago\)/);
  });

  it('answers "never" without an error, and suggests how to check the spelling', async () => {
    const result = await call('last-visit', { venue: 'Somewhere I Have Never Been' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.['found']).toBe(false);
    expect(text(result)).toMatch(/find-filters/);
  });

  it('finds an accented venue typed without accents', async () => {
    const result = await call('last-visit', { venue: 'kisuzem' });
    expect(result.structuredContent?.['found']).toBe(true);
  });
});

describe('find-filters', () => {
  it('turns a fragment into the exact stored values, grouped by kind', async () => {
    const result = await call('find-filters', { query: 'cafe' });
    const categories = result.structuredContent?.['categories'] as Array<{ value: string }>;
    expect(categories.map((match) => match.value)).toContain('Cafe');
    expect(text(result)).toContain('--category');
  });

  it('finds cities and shows how to pass them', async () => {
    const rendered = text(await call('find-filters', { query: 'berl' }));
    expect(rendered).toContain('Berlin');
    expect(rendered).toContain('--city');
  });

  it('ignores case and accents, so a plainly typed word still finds the venue', async () => {
    const result = await call('find-filters', { query: 'kisuzem' });
    const venues = result.structuredContent?.['venues'] as Array<{ value: string }>;
    expect(venues.map((match) => match.value)).toEqual(['Kisüzem']);
  });

  it('says nothing matched rather than returning an empty table', async () => {
    const result = await call('find-filters', { query: 'zzzznope' });
    expect(result.structuredContent?.['totalMatches']).toBe(0);
    expect(text(result)).toMatch(/Nothing in the archive matches/);
  });

  it('reports how many check-ins each value has, so the useful one is obvious', async () => {
    const result = await call('find-filters', { query: 'bar' });
    const categories = result.structuredContent?.['categories'] as Array<{ value: string; checkins: number }>;
    expect(categories[0]?.checkins).toBeGreaterThan(0);
  });
});

describe('checkins-near', () => {
  it('finds what is close and excludes what is not', async () => {
    const result = await call('checkins-near', { lat: 47.4979, lng: 19.0602, radius: 5000 });
    const checkins = result.structuredContent?.['checkins'] as Array<{ id: string }>;
    expect(checkins.map((checkin) => checkin.id).sort()).toEqual(['a', 'b']);
    expect(text(result)).toMatch(/\d+m\s+2019/);
  });

  it('orders by distance, nearest first', async () => {
    const result = await call('checkins-near', { lat: 47.4979, lng: 19.0602, radius: 50_000 });
    const checkins = result.structuredContent?.['checkins'] as Array<{ distanceMeters: number }>;
    expect(checkins[0]!.distanceMeters).toBeLessThanOrEqual(checkins[1]!.distanceMeters);
  });

  it('counts check-ins that could never appear in a geographic query', async () => {
    archive.index.upsert([
      {
        normalised: normaliseCheckin({ id: 'nowhere', createdAt: BASE_CREATED_AT, venue: { name: 'Gone' } }),
        rawJson: '{}',
      },
    ]);
    const result = await call('checkins-near', { lat: 47.4979, lng: 19.0602, radius: 5000 });
    expect(result.structuredContent?.['withoutCoordinates']).toBe(1);
    expect(text(result)).toMatch(/no coordinates at all/);
  });

  it('says something useful when nothing is in range', async () => {
    const rendered = text(await call('checkins-near', { lat: 0, lng: 0, radius: 100 }));
    expect(rendered).toMatch(/latitude first/);
  });
});

describe('the SQL hatch', () => {
  it('runs a SELECT and tabulates it', async () => {
    const rendered = text(
      await call('query-archive', { sql: 'SELECT venue_name, local_date FROM checkins ORDER BY id' }),
    );
    expect(rendered).toContain('venue_name');
    expect(rendered).toContain('Berghain');
    expect(rendered).toContain('3 rows');
  });

  it('refuses a write', async () => {
    const result = await call('query-archive', { sql: 'DELETE FROM checkins' });
    expect(result.isError).toBe(true);
    expect(archive.index.count()).toBe(3);
  });

  it('refuses a write disguised as a query, and says why in one sentence', async () => {
    // RETURNING makes this a statement that returns rows, so it passes any
    // "must be a SELECT" check. SQLite's read-only mode is what stops it.
    const result = await call('query-archive', {
      sql: "DELETE FROM checkins WHERE id = 'a' RETURNING id",
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/opened read-only/);
    expect(text(result)).not.toMatch(/at Object|at CheckinIndex/);
    expect(archive.index.count()).toBe(3);
  });

  it('explains invalid SQL without a stack trace and points at the schema tool', async () => {
    const result = await call('query-archive', { sql: 'SELECT * FROM no_such_table' });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/archive-schema/);
    expect(text(result)).not.toMatch(/at Object|SqliteError:/);
  });

  it('logs a refusal at debug, not as an error with a stack', async () => {
    space.logs.length = 0;
    await call('query-archive', { sql: 'NOT SQL AT ALL' });
    expect(space.logs.join('')).not.toMatch(/error:/);
  });

  it('describes the schema', async () => {
    expect(text(await call('archive-schema'))).toContain('local_ts');
  });
});

describe('the requirement gate', () => {
  it('refuses sync with no token, without touching the network', async () => {
    const result = await call('sync');
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/omocop-swarm auth/);
  });

  it('lets every archive tool work with no token at all', async () => {
    for (const name of [
      'list-checkins',
      'recent-checkins',
      'search-checkins',
      'list-venues',
      'last-visit',
      'find-filters',
      'checkin-stats',
      'checkin-breakdown',
      'checkins-near',
      'sync-status',
      'archive-schema',
      'check-auth-status',
      'authenticate',
    ]) {
      // Required inputs, per tool. A lookup rather than a ternary chain so
      // that adding a tool to the list above is a one-line change here.
      const required: Record<string, Record<string, unknown>> = {
        'checkin-breakdown': { by: 'city' },
        'search-checkins': { query: 'a' },
        'find-filters': { query: 'a' },
        'checkins-near': { lat: 0, lng: 0 },
      };
      const args = required[name] ?? {};
      const result = await call(name, args);
      expect(result.isError, name).toBeUndefined();
    }
  });
});

describe('check-auth-status', () => {
  beforeEach(() => {
    new TokenStore(config, space.logger, space.paths.tokenPath).write('test-token');
  });

  it('stays offline by default, even with a token and a reachable API', async () => {
    const foursquare = new FakeFoursquare();
    const result = await call('check-auth-status', {}, foursquare);
    expect(foursquare.requests).toHaveLength(0);
    expect(result.structuredContent?.['verified']).toBeNull();
  });

  it('asks Foursquare exactly once when told to verify', async () => {
    const foursquare = new FakeFoursquare();
    const result = await call('check-auth-status', { verify: true }, foursquare);
    expect(foursquare.requests.map((request) => request.path)).toEqual(['/v2/users/self']);
    expect(result.structuredContent?.['verified']).toBe(true);
  });
});

describe('an empty archive', () => {
  it('distinguishes "nothing there" from "nothing synced yet"', async () => {
    archive.index.clear();
    const rendered = text(await call('list-checkins'));
    expect(rendered).toMatch(/Run `omocop-swarm sync`/);
  });

  it('reports status without a token', async () => {
    const rendered = text(await call('sync-status'));
    expect(rendered).toContain('token: not configured');
    expect(rendered).toContain('backfill: in progress');
  });
});
