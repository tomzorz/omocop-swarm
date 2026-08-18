/**
 * Configuration, resolved once and validated.
 *
 * Every setting has exactly one name. A credential present under one name and
 * read under another presents as "authentication keeps breaking" rather than as
 * a configuration error, which is close to undiagnosable from the symptom.
 *
 * LOG_LEVEL is deliberately not resolved here: src/logging.ts owns it, because
 * the logger must exist before configuration loads (a config error itself needs
 * somewhere to be logged).
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

export const API_ENDPOINT = 'https://api.foursquare.com/v2/';
export const AUTHORIZE_URL = 'https://foursquare.com/oauth2/authenticate';

/**
 * The `v` parameter every v2 request must carry.
 *
 * Foursquare versions its API by date: a request declares which day's response
 * shapes it was written against, and the server keeps serving those. Computing
 * it from today's date — which several published examples do — opts the client
 * into every future breaking change silently, on a day nobody was deploying.
 * So it is pinned, and moving it is a deliberate edit with a test run after it.
 */
export const API_VERSION = '20250401';

type Env = Record<string, string | undefined>;

const PositivePort = z.coerce.number().int().min(1).max(65535);
const HourOfDay = z.coerce.number().int().min(0).max(23);

export interface Config {
  /**
   * The user OAuth token. Absent is a legitimate state: every tool that reads
   * the local archive works without one, and only the ones that reach
   * Foursquare refuse.
   */
  readonly token?: string;
  /** Registered app credentials. Only `swarm auth` needs the client id. */
  readonly clientId?: string;
  readonly apiEndpoint: string;
  readonly apiVersion: string;
  /** Root of the archive: raw JSONL, the SQLite index, and sync state. */
  readonly dataDir: string;
  readonly authPort: number;
  readonly redirectUri: string;
  /**
   * Hour at which a "day" starts, in venue-local time. 0 is the calendar day.
   * Set it to 6 and a 02:00 check-in counts towards the night before, which is
   * what a human means by "where was I on Friday".
   */
  readonly dayStartHour: number;
  /** Items per API page. The documented maximum is 250. */
  readonly pageSize: number;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/** Reads a setting, treating whitespace-only as absent. */
function read(env: Env, name: string): string | undefined {
  const value = env[name];
  return value !== undefined && value.trim() !== '' ? value.trim() : undefined;
}

/** Builds the configuration, or throws with a message that says what to do. */
export function loadConfig(env: Env = process.env): Config {
  const authPortRaw = read(env, 'SWARM_AUTH_PORT') ?? '3535';
  const parsedPort = PositivePort.safeParse(authPortRaw);
  if (!parsedPort.success) {
    throw new ConfigError(
      `SWARM_AUTH_PORT must be a port number between 1 and 65535, got "${authPortRaw}".`,
    );
  }

  const dayStartRaw = read(env, 'SWARM_DAY_START_HOUR') ?? '0';
  const parsedDayStart = HourOfDay.safeParse(dayStartRaw);
  if (!parsedDayStart.success) {
    throw new ConfigError(
      `SWARM_DAY_START_HOUR must be an hour between 0 and 23, got "${dayStartRaw}".`,
    );
  }

  const pageSizeRaw = read(env, 'SWARM_PAGE_SIZE') ?? '250';
  const parsedPageSize = z.coerce.number().int().min(1).max(250).safeParse(pageSizeRaw);
  if (!parsedPageSize.success) {
    throw new ConfigError(
      `SWARM_PAGE_SIZE must be between 1 and 250 (the API's documented maximum), got "${pageSizeRaw}".`,
    );
  }

  return {
    token: read(env, 'FOURSQUARE_TOKEN'),
    clientId: read(env, 'FOURSQUARE_CLIENT_ID'),
    apiEndpoint: read(env, 'SWARM_API_ENDPOINT') ?? API_ENDPOINT,
    apiVersion: read(env, 'SWARM_API_VERSION') ?? API_VERSION,
    dataDir: read(env, 'SWARM_DATA_DIR') ?? join(homedir(), '.omocop-swarm'),
    authPort: parsedPort.data,
    redirectUri: `http://localhost:${parsedPort.data}/callback`,
    dayStartHour: parsedDayStart.data,
    pageSize: parsedPageSize.data,
  };
}

/**
 * The message shown when something needs the API and no token is configured.
 *
 * It is one string rather than a per-call-site sentence because the fix is the
 * same everywhere and a user who hits it twice should not have to reconcile two
 * differently-worded accounts of the same problem.
 */
export const MISSING_TOKEN_MESSAGE =
  'No Foursquare token is configured, so this cannot reach the API. ' +
  'Run `omocop-swarm auth` to sign in, or set FOURSQUARE_TOKEN. ' +
  'Everything that reads the local archive works without one.';
