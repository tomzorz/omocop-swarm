/**
 * The sync loop.
 *
 * Two phases, and the split is the whole design:
 *
 *   **Catch up** walks from the newest check-in downwards and stops as soon as
 *   it recognises something. On a daily run this is one request. It is the
 *   phase that makes the tool worth running regularly.
 *
 *   **Backfill** walks the rest of the history and is the phase that can take a
 *   while. Its position is written to disk after every single page, so killing
 *   it costs at most one page.
 *
 * The ordering inside a page is deliberate and is the archive's crash story:
 *
 *   1. raw JSONL   — append the verbatim API objects
 *   2. index       — upsert the derived rows
 *   3. state       — advance the offset and the watermarks
 *
 * A crash between 1 and 2 leaves rows on disk that the index has not seen;
 * `reindex` finds them. A crash between 2 and 3 makes the next run re-fetch one
 * page, which upserts to the same values. There is no ordering that loses data,
 * and the reverse order — state first — loses a page on every crash.
 *
 * Sort order is fixed at newest-first and cannot be inverted, so "catch up"
 * always means walking down from the top. `afterTimestamp` turns the stopping
 * rule from a heuristic into a filter when the API honours it; when it does
 * not, the walk stops on recognising an id it already holds, which is a fact
 * about the archive rather than a guess about the API.
 */
import { normaliseCheckin, UnusableCheckinError } from '../domain/checkin.js';
import type { NormalisedCheckin } from '../domain/checkin.js';
import { humanDuration } from '../domain/time.js';
import { fetchCheckins, probeCapabilities, type PageRequest } from '../foursquare/checkins.js';
import type { FoursquareClient } from '../foursquare/client.js';
import type { Logger } from '../logging.js';
import type { CheckinIndex, Indexable } from '../store/index-db.js';
import { appendRaw, type RawWrite } from '../store/raw.js';
import {
  capabilitiesValid,
  readState,
  writeState,
  type SyncState,
} from '../store/state.js';
import type { ArchivePaths } from '../store/paths.js';

export interface SyncOptions {
  /** Items per request. Capped at the API's documented maximum of 250. */
  readonly pageSize: number;
  /** Ignore the watermark and re-walk the whole history. */
  readonly full?: boolean;
  /** Stop after this many requests. A partial run is resumable like any other. */
  readonly maxPages?: number;
  /** Re-run the capability probe even if a cached verdict applies. */
  readonly reprobe?: boolean;
  readonly onProgress?: (progress: SyncProgress) => void;
}

export interface SyncProgress {
  readonly phase: 'catch-up' | 'backfill';
  readonly pages: number;
  readonly fetched: number;
  readonly stored: number;
  /** Total the API reports for the account, when known. */
  readonly remoteCount: number | undefined;
}

export interface SyncResult {
  readonly pages: number;
  /** Check-ins returned by the API across every page. */
  readonly fetched: number;
  /** Check-ins written that the archive had never seen. */
  readonly added: number;
  /** Check-ins re-fetched and refreshed (like counts, new photos). */
  readonly refreshed: number;
  readonly storedTotal: number;
  readonly remoteCount: number | undefined;
  readonly backfillComplete: boolean;
  readonly phasesRun: readonly string[];
  readonly durationMs: number;
  readonly notes: readonly string[];
  readonly stoppedEarly: boolean;
}

interface PageOutcome {
  readonly fetched: number;
  readonly added: number;
  readonly refreshed: number;
  /** True once a page contained something the archive already held. */
  readonly metKnown: boolean;
  /** Fewer items than asked for: the end of the collection. */
  readonly exhausted: boolean;
  readonly remoteCount: number;
}

export interface SyncDeps {
  readonly client: FoursquareClient;
  readonly index: CheckinIndex;
  readonly paths: ArchivePaths;
  readonly logger: Logger;
  readonly apiVersion: string;
}

export async function sync(deps: SyncDeps, options: SyncOptions): Promise<SyncResult> {
  const { client, index, paths, logger, apiVersion } = deps;
  const startedAt = Date.now();
  const notes: string[] = [];
  const phasesRun: string[] = [];

  let state = readState(paths, (warning) => {
    logger.warn(warning);
    notes.push(warning);
  });
  state = { ...state, lastSyncStartedAt: new Date().toISOString() };

  let pages = 0;
  let fetched = 0;
  let added = 0;
  let refreshed = 0;
  let remoteCount: number | undefined = state.remoteCount;
  let stoppedEarly = false;

  const budgetSpent = (): boolean => options.maxPages !== undefined && pages >= options.maxPages;

  // The probe costs four requests and is cached per API version. `full` does
  // not force it: re-walking the history says nothing new about which
  // parameters the API honours.
  if (options.reprobe || !capabilitiesValid(state.capabilities, apiVersion)) {
    const probe = await probeCapabilities(client, apiVersion, logger);
    pages += 4;
    remoteCount = probe.remoteCount;
    notes.push(...probe.notes);
    state = {
      ...state,
      remoteCount: probe.remoteCount,
      capabilities: {
        afterTimestamp: probe.afterTimestamp,
        beforeTimestamp: probe.beforeTimestamp,
        sortOldestFirst: probe.sortOldestFirst,
        probedAt: probe.probedAt,
        apiVersion: probe.apiVersion,
      },
    };
    writeState(paths, state);
  }
  const capabilities = state.capabilities;

  /** Fetches one page, stores it, and reports what happened. */
  const runPage = async (
    request: PageRequest,
    phase: SyncProgress['phase'],
  ): Promise<PageOutcome> => {
    const page = await fetchCheckins(client, request);
    pages += 1;
    remoteCount = page.count;

    const normalised: NormalisedCheckin[] = [];
    const rawWrites: RawWrite[] = [];
    const indexables: Indexable[] = [];

    for (const item of page.items) {
      let record: NormalisedCheckin;
      try {
        record = normaliseCheckin(item);
      } catch (error) {
        // A check-in this codebase cannot make sense of must not stop the sync.
        // It is reported and skipped; the raw line is still written below only
        // if it has the two fields the archive is keyed on, and it does not.
        const message =
          error instanceof UnusableCheckinError
            ? error.message
            : `A check-in could not be read: ${error instanceof Error ? error.message : String(error)}`;
        logger.warn(message);
        if (!notes.includes(message)) notes.push(message);
        continue;
      }
      normalised.push(record);
      rawWrites.push({
        id: record.record.id,
        createdAt: record.record.createdAt,
        localDate: record.record.localDate,
        checkin: item,
      });
      indexables.push({ normalised: record, rawJson: JSON.stringify(item) });
    }

    const ids = normalised.map((record) => record.record.id);
    const known = index.known(ids);

    // Only genuinely new check-ins are appended to the raw files. The archive
    // is append-only, and a weekly sync that re-writes the top page every time
    // would grow the newest month without bound for nothing.
    const fresh = rawWrites.filter((write) => !known.has(write.id));
    appendRaw(paths, fresh);
    index.upsert(indexables);

    fetched += page.items.length;
    added += fresh.length;
    refreshed += ids.length - fresh.length;

    options.onProgress?.({
      phase,
      pages,
      fetched,
      stored: index.count(),
      remoteCount,
    });

    return {
      fetched: page.items.length,
      added: fresh.length,
      refreshed: ids.length - fresh.length,
      metKnown: known.size > 0,
      exhausted: page.items.length < request.limit,
      remoteCount: page.count,
    };
  };

  /** Records the new high and low water marks after a batch of writes. */
  const remark = (current: SyncState): SyncState => ({
    ...current,
    newest: index.newest() ?? current.newest,
    oldest: index.oldest() ?? current.oldest,
    remoteCount,
  });

  // ---- Phase 1: catch up -------------------------------------------------
  //
  // Skipped on an empty archive (there is nothing to catch up to; the backfill
  // does all the work) and on a full re-walk.
  const watermark = state.newest;
  if (!options.full && watermark !== undefined && index.count() > 0) {
    phasesRun.push('catch-up');
    const useAfter = capabilities?.afterTimestamp === true;

    for (let offset = 0; !budgetSpent(); ) {
      const outcome = await runPage(
        {
          limit: options.pageSize,
          offset,
          ...(useAfter ? { afterTimestamp: watermark.createdAt } : {}),
        },
        'catch-up',
      );

      state = remark(state);
      writeState(paths, state);

      if (outcome.exhausted) break;
      // Without `afterTimestamp`, recognising anything means the walk has
      // reached ground the archive already covers. The order is newest-first,
      // so everything below this point is older still.
      if (!useAfter && outcome.metKnown) break;
      offset += options.pageSize;
    }
    if (budgetSpent()) stoppedEarly = true;
  }

  // ---- Phase 2: backfill -------------------------------------------------
  const needsBackfill = options.full || !state.backfill.complete;
  if (needsBackfill && !budgetSpent()) {
    phasesRun.push('backfill');

    let backfill = options.full
      ? { complete: false, offset: 0, startedAt: new Date().toISOString() }
      : { ...state.backfill, startedAt: state.backfill.startedAt ?? new Date().toISOString() };

    // Paging by offset over a collection that can grow at the top is the one
    // way this loop can silently skip a check-in: one added mid-run shifts
    // every later offset by one. Two ways out, both of which hold the window
    // still, and a third that accepts the risk and reports it.
    const stableSort = capabilities?.sortOldestFirst === true;
    const pinnedBefore = !stableSort && capabilities?.beforeTimestamp === true
      ? (backfill.pinnedBefore ?? Math.floor(Date.now() / 1000))
      : undefined;

    if (stableSort) {
      logger.info('Backfilling oldest-first, which is stable while new check-ins arrive.');
    } else if (pinnedBefore !== undefined) {
      logger.info(
        `Backfilling with the window pinned before ${new Date(pinnedBefore * 1000).toISOString()}, ` +
          'so check-ins added during the run cannot shift the paging.',
      );
    } else {
      notes.push(
        'Backfilling by offset alone: the API ignored every parameter that would hold ' +
          'the window still. A check-in created during the run can shift the paging; ' +
          'the totals are compared at the end and a re-run repairs any gap.',
      );
    }

    backfill = { ...backfill, ...(pinnedBefore !== undefined ? { pinnedBefore } : {}) };
    state = { ...state, backfill };
    writeState(paths, state);

    while (!budgetSpent()) {
      const outcome = await runPage(
        {
          limit: options.pageSize,
          offset: backfill.offset,
          ...(stableSort ? { sort: 'oldestfirst' as const } : {}),
          ...(pinnedBefore !== undefined ? { beforeTimestamp: pinnedBefore } : {}),
        },
        'backfill',
      );

      const nextOffset = backfill.offset + outcome.fetched;
      const done = outcome.exhausted || nextOffset >= outcome.remoteCount;
      backfill = { ...backfill, offset: nextOffset, complete: done };

      state = remark({ ...state, backfill });
      writeState(paths, state);

      if (done) break;
    }
    if (budgetSpent() && !state.backfill.complete) stoppedEarly = true;
  }

  // ---- Reconcile ---------------------------------------------------------
  const storedTotal = index.count();
  if (
    state.backfill.complete &&
    remoteCount !== undefined &&
    storedTotal < remoteCount &&
    !stoppedEarly
  ) {
    notes.push(
      `The archive holds ${storedTotal} check-ins and Foursquare reports ${remoteCount}. ` +
        'Run `omocop-swarm sync --full` to re-walk the history; nothing already stored is lost.',
    );
  }
  if (remoteCount !== undefined && storedTotal > remoteCount) {
    notes.push(
      `The archive holds ${storedTotal} check-ins and Foursquare reports only ${remoteCount}. ` +
        'That is expected if any have been deleted since they were archived — the local copy keeps them.',
    );
  }

  state = remark({ ...state, lastSyncFinishedAt: new Date().toISOString() });
  writeState(paths, state);

  const durationMs = Date.now() - startedAt;
  logger.info(
    `Sync finished in ${humanDuration(durationMs / 1000)}: ${added} new, ${refreshed} refreshed, ` +
      `${storedTotal} stored in total.`,
  );

  return {
    pages,
    fetched,
    added,
    refreshed,
    storedTotal,
    remoteCount,
    backfillComplete: state.backfill.complete,
    phasesRun,
    durationMs,
    notes,
    stoppedEarly,
  };
}
