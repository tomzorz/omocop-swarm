import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { TokenStore } from '../../src/auth/token-store.js';
import { workspace, type Workspace } from '../support/factory.js';

let space: Workspace;

const storeWith = (env: Record<string, string | undefined> = {}) =>
  new TokenStore(loadConfig({ ...env, SWARM_DATA_DIR: space.dir }), space.logger, space.paths.tokenPath);

beforeEach(() => {
  space = workspace();
});
afterEach(() => {
  space.cleanup();
});

describe('TokenStore', () => {
  it('reports no token when there is none', () => {
    const store = storeWith();
    expect(store.read()).toBeUndefined();
    expect(store.source()).toBe('none');
  });

  it('reads the environment when it is set', () => {
    const store = storeWith({ FOURSQUARE_TOKEN: 'from-env' });
    expect(store.read()).toBe('from-env');
    expect(store.source()).toBe('environment');
  });

  it('reads the file when the environment is not set', () => {
    const store = storeWith();
    store.write('from-file');
    expect(store.read()).toBe('from-file');
    expect(store.source()).toBe('file');
  });

  it('lets the environment win, because it was stated for this process', () => {
    const store = storeWith({ FOURSQUARE_TOKEN: 'from-env' });
    store.write('from-file');
    expect(store.read()).toBe('from-env');
    expect(store.source()).toBe('environment');
  });

  it('records when the token was saved, without recording the token anywhere else', () => {
    const store = storeWith();
    store.write('secret');
    expect(store.savedAt()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(space.logs.join('')).not.toContain('secret');
  });

  it('replaces a previous token', () => {
    const store = storeWith();
    store.write('first');
    store.write('second');
    expect(store.read()).toBe('second');
  });

  it('leaves no temp file, so the write is atomic', () => {
    const store = storeWith();
    store.write('token');
    expect(JSON.parse(readFileSync(space.paths.tokenPath, 'utf8')).token).toBe('token');
  });

  it('ignores a corrupt token file and says why', () => {
    writeFileSync(space.paths.tokenPath, 'not json');
    const store = storeWith();
    expect(store.read()).toBeUndefined();
    expect(space.logs.join('')).toMatch(/omocop-swarm auth/);
  });

  it('ignores a token file with an empty token', () => {
    writeFileSync(space.paths.tokenPath, JSON.stringify({ token: '   ' }));
    expect(storeWith().read()).toBeUndefined();
  });

  it('creates the archive directory rather than assuming a caller did', () => {
    // The bug this pins: `omocop-swarm auth` reached a sign-in without the
    // archive directory existing, the write failed with ENOENT, and the browser
    // reported "failed to fetch" with nothing in the log.
    const nested = join(space.dir, 'not', 'created', 'yet', 'token.json');
    const store = new TokenStore(loadConfig({ SWARM_DATA_DIR: space.dir }), space.logger, nested);

    expect(() => store.write('token')).not.toThrow();
    expect(store.read()).toBe('token');
  });

  it('forgets a stored token and reports whether there was one', () => {
    const store = storeWith();
    expect(store.forget()).toBe(false);
    store.write('token');
    expect(store.forget()).toBe(true);
    expect(store.read()).toBeUndefined();
  });
});
