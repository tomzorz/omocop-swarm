#!/usr/bin/env node
/**
 * The sign-in helper.
 *
 * Foursquare's v2 user flow used here is the implicit grant: the token comes
 * back in the URL *fragment*, and a fragment is never sent to a server. A
 * redirect handler on localhost therefore receives nothing useful — which is
 * why the usual instructions for this flow end with "copy the token out of your
 * address bar".
 *
 * The way around it is the only way around it: serve a page at the redirect
 * target whose JavaScript reads `location.hash` — the browser will hand it to
 * script even though it never put it on the wire — and post it back to this
 * server over localhost.
 *
 *     browser ── GET /            ─► 302 to foursquare.com/oauth2/authenticate
 *     browser ── (user approves)  ─► 302 to /callback#access_token=...&state=...
 *     browser ── GET /callback    ─► an HTML page; the fragment stayed client-side
 *     page    ── POST /token      ─► { access_token, state }, over 127.0.0.1
 *     server  ── writes token.json, tells the page, stops listening
 *
 * `state` is a random value carried through the round trip and checked on the
 * way back, so another process on this machine cannot post a token of its
 * choosing into the archive during the window the server is open. Foursquare
 * echoing `state` on the implicit flow is not something this code can
 * guarantee, so a missing one is accepted with a loud warning rather than
 * refused — the alternative is a sign-in that cannot complete at all.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AUTHORIZE_URL, loadConfig, type Config } from '../config.js';
import { createLogger, type Logger } from '../logging.js';
import { archivePaths, ensureArchive } from '../store/paths.js';
import { TokenStore } from './token-store.js';

/** How long the server waits for a sign-in before giving up. */
const TIMEOUT_MS = 10 * 60 * 1000;

const constantTimeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

export class AuthServer {
  private readonly state = randomBytes(24).toString('hex');

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly tokens: TokenStore,
  ) {}

  /** The URL the browser is sent to. */
  authorizeUrl(): string {
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('client_id', this.config.clientId ?? '');
    url.searchParams.set('response_type', 'token');
    url.searchParams.set('redirect_uri', this.config.redirectUri);
    url.searchParams.set('state', this.state);
    return url.toString();
  }

  /**
   * Listens until a token arrives, the timeout expires, or the process is
   * stopped. Resolves with the token that was saved.
   */
  async listen(): Promise<string> {
    if (!this.config.clientId) {
      throw new Error(
        'FOURSQUARE_CLIENT_ID is not set, so there is no app to sign in to.\n\n' +
          'Register an app at https://foursquare.com/developers/apps, set its redirect URI to ' +
          `exactly ${this.config.redirectUri}, and put the client id in .env as ` +
          'FOURSQUARE_CLIENT_ID. See docs/setup.md.',
      );
    }

    return new Promise<string>((resolve, reject) => {
      const server = createServer((request, response) => {
        this.route(request, response, (token) => {
          // Closing on the next tick lets the page's POST response flush; a
          // close() inside the handler races the last write and the browser
          // shows a connection error on an otherwise successful sign-in.
          setTimeout(() => server.close(), 50);
          resolve(token);
        }).catch((error: unknown) => {
          // Without this the request simply ends. The browser reports "failed
          // to fetch", the terminal says nothing at all, and the actual cause
          // (a filesystem error, most likely) is nowhere. A handler that throws
          // must still answer, and must still say why on stderr.
          const message = error instanceof Error ? error.message : String(error);
          this.logger.error(`The sign-in server failed while handling a request: ${message}`);
          if (!response.headersSent) {
            json(response, 500, {
              ok: false,
              message: `The sign-in server hit an error and saved nothing: ${message}`,
            });
          } else {
            response.end();
          }
        });
      });

      const timer = setTimeout(() => {
        server.close();
        reject(new Error(`No sign-in completed within ${TIMEOUT_MS / 60000} minutes. Nothing was saved.`));
      }, TIMEOUT_MS);
      timer.unref();

      server.on('error', reject);
      server.on('close', () => clearTimeout(timer));

      // 127.0.0.1, not 0.0.0.0: this listener accepts a credential, and it has
      // no business being reachable from the network.
      server.listen(this.config.authPort, '127.0.0.1', () => {
        this.logger.info(
          `Sign-in server listening. Open this in a browser:\n\n  http://localhost:${this.config.authPort}/\n`,
        );
      });
    });
  }

  private async route(
    request: IncomingMessage,
    response: ServerResponse,
    done: (token: string) => void,
  ): Promise<void> {
    const url = new URL(request.url ?? '/', `http://localhost:${this.config.authPort}`);

    if (request.method === 'GET' && url.pathname === '/') {
      response.writeHead(302, { Location: this.authorizeUrl() });
      response.end();
      return;
    }

    if (request.method === 'GET' && url.pathname === '/callback') {
      html(response, 200, callbackPage());
      return;
    }

    if (request.method === 'POST' && url.pathname === '/token') {
      await this.receiveToken(request, response, done);
      return;
    }

    html(response, 404, page('Not found', 'That is not a page this sign-in server serves.'));
  }

  private async receiveToken(
    request: IncomingMessage,
    response: ServerResponse,
    done: (token: string) => void,
  ): Promise<void> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.from(chunk as Buffer);
      size += buffer.length;
      // A token is a short string. Anything large is not one, and reading it
      // into memory would be the only thing this endpoint could be abused for.
      if (size > 8192) {
        json(response, 413, { error: 'Payload too large.' });
        return;
      }
      chunks.push(buffer);
    }

    let payload: { access_token?: unknown; state?: unknown; error?: unknown };
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof payload;
    } catch {
      json(response, 400, { error: 'That was not JSON.' });
      return;
    }

    if (typeof payload.error === 'string' && payload.error !== '') {
      this.logger.error(`Foursquare refused the sign-in: ${payload.error}`);
      json(response, 200, { ok: false, message: `Foursquare refused the sign-in: ${payload.error}` });
      return;
    }

    const token = typeof payload.access_token === 'string' ? payload.access_token.trim() : '';
    if (token === '') {
      json(response, 400, { error: 'No access_token was in the redirect.' });
      return;
    }

    if (typeof payload.state === 'string' && payload.state !== '') {
      if (!constantTimeEqual(payload.state, this.state)) {
        this.logger.error('The state value did not match. Nothing was saved.');
        json(response, 400, {
          error: 'The state value did not match the one this sign-in started with. Nothing was saved.',
        });
        return;
      }
    } else {
      this.logger.warn(
        'Foursquare did not echo the state parameter, so the round trip could not be verified. ' +
          'The token was accepted because the request came from this machine. Sign in again if ' +
          'you did not start this.',
      );
    }

    this.tokens.write(token);
    json(response, 200, { ok: true, message: 'Signed in. The token has been saved.' });
    done(token);
  }
}

const html = (response: ServerResponse, status: number, body: string): void => {
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    // The page handles a credential; nothing about it should be cached, and it
    // has no business loading anything from anywhere.
    //
    // `connect-src 'self'` is load-bearing, not decoration. The whole flow
    // depends on the page posting the fragment back to this server, and
    // connect-src falls back to default-src when it is absent — so
    // `default-src 'none'` alone silently blocks the one request the page
    // exists to make. The browser then rejects it as "TypeError: Failed to
    // fetch", which names neither CSP nor the directive responsible.
    'Cache-Control': 'no-store',
    'Content-Security-Policy':
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
      "connect-src 'self'; form-action 'none'; base-uri 'none'",
    'Referrer-Policy': 'no-referrer',
  });
  response.end(body);
};

const json = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
};

const page = (title: string, body: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>
  body { font: 16px/1.6 system-ui, sans-serif; max-width: 34rem; margin: 4rem auto; padding: 0 1rem; }
  h1 { font-size: 1.3rem; }
  code { background: #eee; padding: .1rem .3rem; border-radius: 3px; }
</style></head>
<body><h1>${title}</h1><p>${body}</p></body></html>`;

/**
 * The page that does the actual work.
 *
 * `history.replaceState` strips the fragment as soon as it has been read, so
 * the token does not sit in the address bar or in browser history once it has
 * been handed over.
 */
const callbackPage = (): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Signing in…</title>
<meta name="referrer" content="no-referrer">
<style>
  body { font: 16px/1.6 system-ui, sans-serif; max-width: 34rem; margin: 4rem auto; padding: 0 1rem; }
  h1 { font-size: 1.3rem; }
  .bad { color: #a00; }
</style></head>
<body>
<h1 id="title">Signing in…</h1>
<p id="detail">Reading the token out of the redirect.</p>
<script>
  (function () {
    var title = document.getElementById('title');
    var detail = document.getElementById('detail');
    var fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''));

    var payload = {
      access_token: fragment.get('access_token') || '',
      state: fragment.get('state') || '',
      error: fragment.get('error') || fragment.get('error_description') || ''
    };

    // Out of the address bar and out of history before anything else happens.
    history.replaceState(null, '', window.location.pathname);

    if (!payload.access_token && !payload.error) {
      title.textContent = 'Nothing came back';
      title.className = 'bad';
      detail.textContent = 'The redirect carried no token. Start again from http://localhost:' +
        window.location.port + '/';
      return;
    }

    fetch('/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function (response) { return response.json(); })
      .then(function (result) {
        title.textContent = result.ok ? 'Signed in' : 'Sign-in failed';
        if (!result.ok) title.className = 'bad';
        detail.textContent = result.message || result.error ||
          'Something went wrong and the reason was not given.';
        if (result.ok) {
          detail.textContent += ' You can close this tab and go back to the terminal.';
        }
      })
      .catch(function (error) {
        title.textContent = 'Could not reach the local sign-in server';
        title.className = 'bad';
        detail.textContent = String(error);
      });
  })();
</script>
</body></html>`;

/** Entry point for `omocop-swarm-auth` and `omocop-swarm auth`. */
export async function main(): Promise<void> {
  const { config: dotenvConfig } = await import('dotenv');
  dotenvConfig();

  const logger = createLogger();
  const config = loadConfig();
  const paths = archivePaths(config.dataDir);
  ensureArchive(paths);

  const store = new TokenStore(config, logger, paths.tokenPath);
  await new AuthServer(config, logger, store).listen();
  logger.info('Done. Run `omocop-swarm sync` to pull your check-in history.');
}

/**
 * Whether this module is the program being run.
 *
 * The CLI imports `AuthServer` from here, so a guard that merely matched the
 * file name would start a listener on every `omocop-swarm` invocation. Comparing
 * the resolved entry point against this module's own path is the only form that
 * does not — `realpath` on both sides because npm installs the bin as a symlink.
 */
function runningAsScript(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (runningAsScript()) {
  main().catch((error: unknown) => {
    createLogger().error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
