/**
 * Sync state: what has been fetched, and what the API turned out to support.
 *
 * This file is what makes a sync resumable. A backfill of a long history is
 * many minutes of paging, and the process can die in the middle of it — a
 * closed laptop, a dropped connection, a Ctrl-C. Without a persisted position
 * the next run starts from zero, which is not merely slow: it is the reason
 * people give up on running the thing regularly.
 *
 * Written atomically (temp file, then rename) because the failure being guarded
 * against is a crash mid-write, and a half-written state file is worse than a
 * stale one — it fails to parse, and the next run treats the archive as empty.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import type { ArchivePaths } from './paths.js';

/**
 * What a probe found out about the undocumented paging parameters.
 *
 * The current reference for `/users/self/checkins` documents only `limit` and
 * `offset`. `afterTimestamp`, `beforeTimestamp` and `sort` were in the older v2
 * reference and appear to still work, but "appears to still work" is not
 * something to build a sync loop on top of. So they are probed once, the answer
 * is recorded here, and every one of them has a fallback path that needs
 * nothing but `limit` and `offset`.
 */
export const CapabilitiesSchema = z.object({
  /** `afterTimestamp` actually filters, rather than being ignored. */
  afterTimestamp: z.boolean(),
  /** `beforeTimestamp` actually filters — this is what makes backfill stable. */
  beforeTimestamp: z.boolean(),
  /** `sort=oldestfirst` actually reverses the order. */
  sortOldestFirst: z.boolean(),
  probedAt: z.string(),
  /** The `v` the probe ran under; a version bump invalidates the answer. */
  apiVersion: z.string(),
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

const MarkSchema = z.object({ id: z.string(), createdAt: z.number() });

export const SyncStateSchema = z.object({
  version: z.literal(1).default(1),
  lastSyncStartedAt: z.string().optional(),
  lastSyncFinishedAt: z.string().optional(),
  /** Newest check-in stored. The incremental pass walks down until it meets it. */
  newest: MarkSchema.optional(),
  /** Oldest check-in stored. Informational; the backfill offset is the real position. */
  oldest: MarkSchema.optional(),
  backfill: z
    .object({
      /** True once a pass has walked the whole history end to end. */
      complete: z.boolean().default(false),
      /** Offset the next page starts at. Persisted after every page. */
      offset: z.number().default(0),
      startedAt: z.string().optional(),
      /** `response.checkins.count` when the pass began. */
      expectedTotal: z.number().optional(),
      /**
       * The instant the backfill pinned itself to, when `beforeTimestamp`
       * works. Holding the window still is what stops a check-in added
       * mid-backfill from shifting every later offset by one and skipping a row.
       */
      pinnedBefore: z.number().optional(),
    })
    .default({ complete: false, offset: 0 }),
  /** `response.checkins.count` at the last successful sync. */
  remoteCount: z.number().optional(),
  capabilities: CapabilitiesSchema.optional(),
});
export type SyncState = z.infer<typeof SyncStateSchema>;

export const EMPTY_STATE: SyncState = {
  version: 1,
  backfill: { complete: false, offset: 0 },
};

/**
 * Reads the state, falling back to empty.
 *
 * A malformed file is reported and then ignored rather than thrown on. State is
 * an optimisation — every position in it can be rediscovered by walking the API
 * again — so refusing to run because of it would trade a slow sync for no sync.
 */
export function readState(paths: ArchivePaths, onWarning?: (message: string) => void): SyncState {
  let text: string;
  try {
    text = readFileSync(paths.statePath, 'utf8');
  } catch {
    return EMPTY_STATE;
  }

  try {
    const parsed = SyncStateSchema.safeParse(JSON.parse(text));
    if (parsed.success) return parsed.data;
    onWarning?.(
      `${paths.statePath} does not match the expected shape and was ignored; ` +
        `this run will re-establish it. (${parsed.error.issues[0]?.message ?? 'unknown issue'})`,
    );
  } catch (error) {
    onWarning?.(
      `${paths.statePath} is not valid JSON and was ignored; this run will re-establish it. ` +
        `(${error instanceof Error ? error.message : String(error)})`,
    );
  }
  return EMPTY_STATE;
}

export function writeState(paths: ArchivePaths, state: SyncState): void {
  const temp = `${paths.statePath}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(temp, paths.statePath);
}

/** Whether a recorded probe still applies. */
export const capabilitiesValid = (
  capabilities: Capabilities | undefined,
  apiVersion: string,
): capabilities is Capabilities =>
  capabilities !== undefined && capabilities.apiVersion === apiVersion;
