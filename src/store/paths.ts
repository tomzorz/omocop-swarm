/**
 * Where everything lives under the archive root.
 *
 * One file so that nothing else in the codebase joins a path by hand, and so
 * the layout can be read off in one place rather than reconstructed from a
 * dozen `join` calls.
 *
 *   <dataDir>/
 *     raw/checkins-YYYY-MM.jsonl   append-only truth, one JSON object per line
 *     index.sqlite                 derived; `omocop-swarm reindex` rebuilds it
 *     state.json                   sync watermarks and probed API capabilities
 *     token.json                   written by `omocop-swarm auth`
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface ArchivePaths {
  readonly root: string;
  readonly rawDir: string;
  readonly indexPath: string;
  readonly statePath: string;
  readonly tokenPath: string;
}

export function archivePaths(dataDir: string): ArchivePaths {
  return {
    root: dataDir,
    rawDir: join(dataDir, 'raw'),
    indexPath: join(dataDir, 'index.sqlite'),
    statePath: join(dataDir, 'state.json'),
    tokenPath: join(dataDir, 'token.json'),
  };
}

/** Creates the archive root and its subdirectories. Safe to call repeatedly. */
export function ensureArchive(paths: ArchivePaths): void {
  mkdirSync(paths.rawDir, { recursive: true });
}

/**
 * The raw file a check-in belongs in, named for its venue-local month.
 *
 * Monthly files rather than one big one: a decade of check-ins stays greppable,
 * a partial write damages one month instead of everything, and the file listing
 * alone shows the shape of the history.
 */
export const rawFileFor = (paths: ArchivePaths, localDate: string): string =>
  join(paths.rawDir, `checkins-${localDate.slice(0, 7)}.jsonl`);
