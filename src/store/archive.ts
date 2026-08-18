/**
 * The archive, opened.
 *
 * One object holding the three things every tool needs — where the files are,
 * the index handle, and whether the index is currently trustworthy — so that no
 * tool has to know the opening sequence, and so "the schema changed under you"
 * is answered once rather than per tool.
 */
import { existsSync } from 'node:fs';
import type { Config } from '../config.js';
import type { Logger } from '../logging.js';
import { CheckinIndex } from './index-db.js';
import { archivePaths, ensureArchive, type ArchivePaths } from './paths.js';
import { rawFiles } from './raw.js';

export class Archive {
  private constructor(
    readonly paths: ArchivePaths,
    readonly index: CheckinIndex,
    /** The index was recreated for a schema change and holds nothing yet. */
    readonly rebuildRequired: boolean,
  ) {}

  static open(config: Config, logger: Logger): Archive {
    const paths = archivePaths(config.dataDir);
    ensureArchive(paths);
    const { index, rebuildRequired } = CheckinIndex.open(paths.indexPath);
    if (rebuildRequired) {
      logger.warn(
        `The index at ${paths.indexPath} was built by a different schema version and has ` +
          'been recreated empty. Run `omocop-swarm reindex` to refill it from the raw files. ' +
          'No archived check-in was touched.',
      );
    }
    return new Archive(paths, index, rebuildRequired);
  }

  close(): void {
    this.index.close();
  }

  /**
   * The sentence to prepend when a query is about to answer from an index that
   * is empty for a reason other than an empty history. Without it, "0 check-ins
   * on that day" is indistinguishable from "the archive has not been built".
   */
  caveat(): string | undefined {
    if (this.rebuildRequired) {
      return 'The index was recreated for a schema change and is empty. Run `omocop-swarm reindex` to refill it from the raw files.';
    }
    if (this.index.count() === 0) {
      return rawFiles(this.paths).length > 0
        ? 'The index is empty but raw files exist. Run `omocop-swarm reindex`.'
        : 'The archive is empty. Run `omocop-swarm sync` to fetch your check-in history.';
    }
    return undefined;
  }

  /** Whether an index file exists at all, for the read-only SQL escape hatch. */
  get indexExists(): boolean {
    return existsSync(this.paths.indexPath);
  }
}
