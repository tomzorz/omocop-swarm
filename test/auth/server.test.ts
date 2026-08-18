/**
 * The sign-in server, driven the way a browser drives it.
 *
 * A real listener on a real port, real HTTP requests, and the fragment handled
 * the way the callback page handles it — because the whole reason this server
 * exists is a browser behaviour, and a test that stubbed the transport would be
 * testing the wrong thing.
 */
import { createServer } from 'node:net';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthServer } from '../../src/auth/server.js';
import { TokenStore } from '../../src/auth/token-store.js';
import { loadConfig, type Config } from '../../src/config.js';
import { workspace, type Workspace } from '../support/factory.js';

/** Asks the OS for a port it is willing to give out, avoiding reserved ranges. */
const freePort = async (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });

let space: Workspace;
let config: Config;
let store: TokenStore;
let server: AuthServer;
let pending: Promise<string>;

beforeEach(async () => {
  space = workspace();
  const port = await freePort();
  config = loadConfig({
    SWARM_DATA_DIR: space.dir,
    SWARM_AUTH_PORT: String(port),
    FOURSQUARE_CLIENT_ID: 'test-client-id',
  });
  store = new TokenStore(config, space.logger, space.paths.tokenPath);
  server = new AuthServer(config, space.logger, store);
  pending = server.listen();
  // Swallow the rejection when a test never completes a sign-in.
  pending.catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 50));
});

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 60));
  space.cleanup();
});

const base = (): string => `http://127.0.0.1:${config.authPort}`;

const stateFromAuthorizeUrl = (): string =>
  new URL(server.authorizeUrl()).searchParams.get('state') ?? '';

const postToken = (body: unknown): Promise<Response> =>
  fetch(`${base()}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('the authorize URL', () => {
  it('asks for the implicit flow at the registered redirect', () => {
    const url = new URL(server.authorizeUrl());
    expect(url.origin + url.pathname).toBe('https://foursquare.com/oauth2/authenticate');
    expect(url.searchParams.get('response_type')).toBe('token');
    expect(url.searchParams.get('client_id')).toBe('test-client-id');
    expect(url.searchParams.get('redirect_uri')).toBe(config.redirectUri);
  });

  it('carries a state value long enough to be unguessable', () => {
    expect(stateFromAuthorizeUrl()).toMatch(/^[0-9a-f]{48}$/);
  });
});

describe('the browser journey', () => {
  it('sends the root straight to Foursquare', async () => {
    const response = await fetch(`${base()}/`, { redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('foursquare.com/oauth2/authenticate');
  });

  it('serves a callback page that reads the fragment client-side', async () => {
    const response = await fetch(`${base()}/callback`);
    const body = await response.text();
    expect(response.status).toBe(200);
    // The fragment never reaches the server, so the page must read it itself
    // and post it back. Without these two the whole flow cannot work.
    expect(body).toContain('window.location.hash');
    expect(body).toContain("fetch('/token'");
  });

  it('keeps the token out of the address bar and out of history', async () => {
    const body = await (await fetch(`${base()}/callback`)).text();
    expect(body).toContain('history.replaceState');
  });

  it('tells the browser not to cache or leak the page', async () => {
    const response = await fetch(`${base()}/callback`);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('does not let its own Content-Security-Policy block the post it depends on', async () => {
    // The bug this pins, and it presented identically to an unrelated one:
    // `default-src 'none'` with no connect-src blocks fetch(), because
    // connect-src falls back to default-src. The browser then reports
    // "TypeError: Failed to fetch", naming neither CSP nor the directive.
    //
    // Nothing in this file executes the page, so this asserts on the header.
    // Node's fetch does not enforce CSP, which is exactly why a passing
    // request-level test proved nothing about a real browser.
    const csp = (await fetch(`${base()}/callback`)).headers.get('content-security-policy') ?? '';

    expect(csp).toMatch(/connect-src[^;]*'self'/);
    expect(csp).toMatch(/script-src[^;]*'unsafe-inline'/);
    // Still locked down everywhere it does not need to reach.
    expect(csp).toMatch(/default-src 'none'/);
    expect(csp).toMatch(/form-action 'none'/);
  });

  it('saves the token when the state matches', async () => {
    const response = await postToken({
      access_token: 'the-real-token',
      state: stateFromAuthorizeUrl(),
    });

    expect(await response.json()).toMatchObject({ ok: true });
    await expect(pending).resolves.toBe('the-real-token');
    expect(store.read()).toBe('the-real-token');
  });

  it('never writes the token to the log', async () => {
    await postToken({ access_token: 'the-real-token', state: stateFromAuthorizeUrl() });
    await pending;
    expect(space.logs.join('')).not.toContain('the-real-token');
  });
});

describe('what it refuses', () => {
  it('refuses a token posted with the wrong state', async () => {
    const response = await postToken({ access_token: 'planted', state: 'not-the-state' });
    expect(response.status).toBe(400);
    expect(store.read()).toBeUndefined();
  });

  it('refuses a post with no token in it', async () => {
    const response = await postToken({ state: stateFromAuthorizeUrl() });
    expect(response.status).toBe(400);
    expect(store.read()).toBeUndefined();
  });

  it('refuses a body that is not JSON', async () => {
    expect((await postToken('<html>')).status).toBe(400);
  });

  it('refuses an oversized body rather than reading it into memory', async () => {
    const response = await postToken({ access_token: 'x'.repeat(20_000) });
    expect(response.status).toBe(413);
  });

  it('reports an error Foursquare sent back instead of saving anything', async () => {
    const response = await postToken({ error: 'access_denied', state: stateFromAuthorizeUrl() });
    expect(await response.json()).toMatchObject({ ok: false });
    expect(store.read()).toBeUndefined();
  });

  it('accepts a missing state but says loudly that it could not verify it', async () => {
    // Foursquare echoing `state` on the implicit flow is not guaranteed, and a
    // sign-in that cannot complete is worse than one that warns.
    const response = await postToken({ access_token: 'unverified-token' });
    expect(await response.json()).toMatchObject({ ok: true });
    expect(space.logs.join('')).toMatch(/did not echo the state parameter/);
    await pending;
  });

  it('404s anything else', async () => {
    expect((await fetch(`${base()}/../../etc/passwd`)).status).toBe(404);
    expect((await fetch(`${base()}/token`)).status).toBe(404);
  });
});

describe('when the handler itself fails', () => {
  it('answers with the reason instead of dropping the connection', async () => {
    // The bug this pins: a throw inside the request handler ended the request
    // with no response. The browser said "TypeError: Failed to fetch", the
    // terminal said nothing, and the real cause was nowhere to be found.
    //
    // A real, non-simulated failure: the token path's parent is a file, so
    // creating the directory for it cannot succeed.
    const blocked = join(space.dir, 'a-file');
    writeFileSync(blocked, 'not a directory');

    const port = await freePort();
    const brokenConfig = loadConfig({
      SWARM_DATA_DIR: space.dir,
      SWARM_AUTH_PORT: String(port),
      FOURSQUARE_CLIENT_ID: 'test-client-id',
    });
    const brokenStore = new TokenStore(
      brokenConfig,
      space.logger,
      join(blocked, 'token.json'),
    );
    const brokenServer = new AuthServer(brokenConfig, space.logger, brokenStore);
    const listening = brokenServer.listen();
    listening.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const response = await fetch(`http://127.0.0.1:${port}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        access_token: 'a-token',
        state: new URL(brokenServer.authorizeUrl()).searchParams.get('state'),
      }),
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ ok: false });
    expect(space.logs.join('')).toMatch(/failed while handling a request/);
  });
});

describe('configuration', () => {
  it('refuses to start without a client id, and says how to get one', async () => {
    const bare = loadConfig({ SWARM_DATA_DIR: space.dir });
    const server = new AuthServer(bare, space.logger, store);
    await expect(server.listen()).rejects.toThrow(/FOURSQUARE_CLIENT_ID/);
    await expect(server.listen()).rejects.toThrow(/foursquare\.com\/developers/);
  });
});
