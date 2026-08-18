/**
 * Rebuilding the index from the raw files.
 *
 * This is the operation that makes every other decision in the project cheap.
 * The schema can change without a migration, a normalisation bug is fixable
 * after the fact, and a damaged database is not a lost archive — because the
 * index is a projection and this rebuilds it from the only copy that matters.
 *
 * It touches the network not at all, so it is safe to run at any time and
 * needs no token.
 */
import { normaliseCheckin, UnusableCheckinError } from '../domain/checkin.js';
import type { Logger } from '../logging.js';
import type { CheckinIndex, Indexable } from '../store/index-db.js';
import type { ArchivePaths } from '../store/paths.js';
import { readRaw } from '../store/raw.js';

export interface ReindexResult {
  /** Lines read across every monthly file. */
  readonly linesRead: number;
  /** Distinct check-ins written to the index. */
  readonly indexed: number;
  /** Lines superseded by a later copy of the same check-in. */
  readonly duplicates: number;
  /** Lines that could not be parsed or normalised, with the reason. */
  readonly skipped: ReadonlyArray<{ readonly where: string; readonly message: string }>;
  readonly durationMs: number;
}

/** Rows per transaction. Large enough to amortise fsync, small enough to bound memory. */
const BATCH = 500;

export async function reindex(
  paths: ArchivePaths,
  index: CheckinIndex,
  logger: Logger,
): Promise<ReindexResult> {
  const startedAt = Date.now();
  const skipped: Array<{ where: string; message: string }> = [];

  let linesRead = 0;
  let duplicates = 0;

  /**
   * A check-in can appear on several lines — it is re-fetched whenever a sync
   * passes over it again, and the counts on it may have changed. The last line
   * wins, which matches the upsert's replace semantics, so the pass has to know
   * which ids it has already seen within this run.
   */
  const seen = new Set<string>();
  let batch: Indexable[] = [];

  const flush = (): void => {
    if (batch.length === 0) return;
    index.upsert(batch);
    batch = [];
  };

  // Emptied first: a rebuild that merged into whatever was already there would
  // leave rows for check-ins deleted from the raw files, and "rebuild" would
  // quietly mean "top up".
  index.clear();

  for await (const entry of readRaw(paths, (problem) => {
    skipped.push({
      where: `${problem.file}:${problem.line}`,
      message: problem.message,
    });
  })) {
    linesRead += 1;
    if (seen.has(entry.id)) duplicates += 1;
    seen.add(entry.id);

    try {
      batch.push({
        normalised: normaliseCheckin(entry.checkin),
        rawJson: JSON.stringify(entry.checkin),
      });
    } catch (error) {
      skipped.push({
        where: entry.id,
        message:
          error instanceof UnusableCheckinError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error),
      });
      continue;
    }

    if (batch.length >= BATCH) flush();
  }

  flush();

  const result: ReindexResult = {
    linesRead,
    indexed: index.count(),
    duplicates,
    skipped,
    durationMs: Date.now() - startedAt,
  };

  logger.info(
    `Reindexed ${result.indexed} check-in(s) from ${linesRead} line(s)` +
      `${duplicates > 0 ? `, ${duplicates} superseded by a later copy` : ''}` +
      `${skipped.length > 0 ? `, ${skipped.length} skipped` : ''}.`,
  );

  return result;
}
