/**
 * Reading `/users/self/checkins`, and finding out what it actually supports.
 *
 * The reference for this endpoint documents four parameters: `oauth_token`,
 * `v`, `limit` (max 250) and `offset`. It does not document `afterTimestamp`,
 * `beforeTimestamp` or `sort`, all of which were in the older v2 reference and
 * all of which are the difference between a pleasant sync and an awkward one.
 *
 * Rather than assume either way, this probes. Each parameter is sent in a
 * request whose answer is unambiguous if the parameter works and unambiguous if
 * it is ignored, and the verdict is cached in the archive's state file. Every
 * one of them has a fallback that needs nothing beyond `limit` and `offset`, so
 * a "no" anywhere costs efficiency and never correctness.
 *
 * The trick each probe uses is the same: ask for something that the newest
 * check-in cannot be the answer to. An ignored filter returns the newest
 * check-in, because the default order is newest-first — so getting the newest
 * back is the signature of a parameter that did nothing.
 */
import type { FoursquareClient, QueryValue } from './client.js';
import type { Logger } from '../logging.js';
import type { Capabilities } from '../store/state.js';

export const CHECKINS_PATH = 'users/self/checkins';

/** The documented maximum for `limit`. */
export const MAX_PAGE_SIZE = 250;

export interface PageRequest {
  readonly limit: number;
  readonly offset: number;
  /** Only check-ins created after this Unix second. */
  readonly afterTimestamp?: number;
  /** Only check-ins created before this Unix second. */
  readonly beforeTimestamp?: number;
  readonly sort?: 'newestfirst' | 'oldestfirst';
}

export interface CheckinPage {
  /** `response.checkins.count` — the account's total, not the page's length. */
  readonly count: number;
  readonly items: ReadonlyArray<Record<string, unknown>>;
}

interface CheckinsResponse {
  readonly checkins?: {
    readonly count?: number;
    readonly items?: unknown;
  };
}

export async function fetchCheckins(
  client: FoursquareClient,
  request: PageRequest,
): Promise<CheckinPage> {
  const query: Record<string, QueryValue> = {
    limit: Math.min(request.limit, MAX_PAGE_SIZE),
    offset: request.offset,
  };
  if (request.afterTimestamp !== undefined) query['afterTimestamp'] = request.afterTimestamp;
  if (request.beforeTimestamp !== undefined) query['beforeTimestamp'] = request.beforeTimestamp;
  if (request.sort !== undefined) query['sort'] = request.sort;

  const response = await client.get<CheckinsResponse>(CHECKINS_PATH, query);
  const items = Array.isArray(response.checkins?.items)
    ? (response.checkins.items as unknown[]).filter(
        (item): item is Record<string, unknown> =>
          typeof item === 'object' && item !== null && !Array.isArray(item),
      )
    : [];

  return { count: response.checkins?.count ?? items.length, items };
}

const idOf = (page: CheckinPage): string | undefined => {
  const first = page.items[0];
  return typeof first?.['id'] === 'string' ? first['id'] : undefined;
};

const createdAtOf = (page: CheckinPage): number | undefined => {
  const first = page.items[0];
  return typeof first?.['createdAt'] === 'number' ? first['createdAt'] : undefined;
};

export interface Probe extends Capabilities {
  /** The account's total at probe time, which the caller wants anyway. */
  readonly remoteCount: number;
  /** Why a capability came back false, when it was not a clean "ignored". */
  readonly notes: readonly string[];
}

/**
 * Probes the three undocumented parameters. Four requests, run once per
 * archive per `v`.
 *
 * @param apiVersion recorded with the verdict, because a different `v` may
 *   behave differently and the cached answer must not outlive its assumptions
 */
export async function probeCapabilities(
  client: FoursquareClient,
  apiVersion: string,
  logger: Logger,
): Promise<Probe> {
  const notes: string[] = [];
  const baseline = await fetchCheckins(client, { limit: 1, offset: 0 });
  const newestId = idOf(baseline);
  const newestCreatedAt = createdAtOf(baseline);

  const unusable = (reason: string): Probe => {
    notes.push(reason);
    return {
      afterTimestamp: false,
      beforeTimestamp: false,
      sortOldestFirst: false,
      probedAt: new Date().toISOString(),
      apiVersion,
      remoteCount: baseline.count,
      notes,
    };
  };

  if (newestId === undefined || newestCreatedAt === undefined) {
    return unusable(
      'The account returned no check-ins, so nothing could be probed. ' +
        'Paging will use offsets only.',
    );
  }
  if (baseline.count < 2) {
    return unusable(
      'The account has fewer than two check-ins, so a probe cannot tell a working ' +
        'filter from an ignored one. Paging will use offsets only.',
    );
  }

  // Ignored → the newest check-in comes back. Honoured → something older, or
  // nothing at all when the newest was the only candidate.
  const before = await fetchCheckins(client, {
    limit: 1,
    offset: 0,
    beforeTimestamp: newestCreatedAt - 1,
  });
  const beforeTimestamp = before.items.length === 0 || idOf(before) !== newestId;

  // One second past the newest: nothing can exist after it, so an honoured
  // filter returns nothing whether its boundary is inclusive or exclusive.
  const after = await fetchCheckins(client, {
    limit: 1,
    offset: 0,
    afterTimestamp: newestCreatedAt + 1,
  });
  const afterTimestamp = after.items.length === 0;

  const oldest = await fetchCheckins(client, { limit: 1, offset: 0, sort: 'oldestfirst' });
  const sortOldestFirst = oldest.items.length > 0 && idOf(oldest) !== newestId;

  const verdict: Probe = {
    afterTimestamp,
    beforeTimestamp,
    sortOldestFirst,
    probedAt: new Date().toISOString(),
    apiVersion,
    remoteCount: baseline.count,
    notes,
  };

  logger.info(
    `API probe (v=${apiVersion}): afterTimestamp ${yesNo(afterTimestamp)}, ` +
      `beforeTimestamp ${yesNo(beforeTimestamp)}, sort=oldestfirst ${yesNo(sortOldestFirst)}.`,
  );
  if (!afterTimestamp && !beforeTimestamp && !sortOldestFirst) {
    notes.push(
      'None of the undocumented paging parameters had any effect. Syncing works, ' +
        'but a check-in added while a long backfill runs can shift the offsets ' +
        'under it; the run reports any mismatch and a re-run repairs it.',
    );
  }
  return verdict;
}

const yesNo = (value: boolean): string => (value ? 'works' : 'ignored');
