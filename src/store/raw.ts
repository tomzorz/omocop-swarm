/**
 * The raw JSONL archive — the part that is actually the archive.
 *
 * Everything else in this project is derived. The SQLite index can be deleted
 * and rebuilt from these files; these files cannot be rebuilt from anything,
 * because Foursquare is the only other copy and the whole point of the exercise
 * is not depending on that.
 *
 * Two rules follow, and neither is negotiable:
 *
 *   1. **Append only.** A line, once written, is never edited or removed. A
 *      check-in fetched twice produces two lines; the reader keeps the last.
 *   2. **Write raw, unmodified.** The `checkin` field is exactly what the API
 *      returned, with no normalisation applied. Every mistake in
 *      domain/checkin.ts is then recoverable by re-indexing, and a field this
 *      codebase does not know about yet is still on disk when it turns out to
 *      matter.
 */
import {
  appendFileSync,
  closeSync,
  createReadStream,
  existsSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { type ArchivePaths, rawFileFor } from './paths.js';

/** One line of a raw file. */
export interface RawEntry {
  readonly id: string;
  /** Duplicated out of the check-in so a reader can sort without parsing deeply. */
  readonly createdAt: number;
  /** When this copy was fetched, ISO 8601. Distinguishes re-fetches of one id. */
  readonly fetchedAt: string;
  /** Verbatim API object. */
  readonly checkin: Record<string, unknown>;
}

export interface RawWrite {
  readonly id: string;
  readonly createdAt: number;
  /** Venue-local date, which decides the monthly file. */
  readonly localDate: string;
  readonly checkin: Record<string, unknown>;
}

/**
 * Appends check-ins to their monthly files.
 *
 * Batched per file and written with a single `appendFileSync` each: an append
 * of one buffer is the closest thing to atomic that a plain file gives, and a
 * per-line call would leave a torn line where a crash happened to land.
 *
 * @returns the number of lines written
 */
export function appendRaw(
  paths: ArchivePaths,
  entries: readonly RawWrite[],
  fetchedAt = new Date().toISOString(),
): number {
  if (entries.length === 0) return 0;

  const byFile = new Map<string, string[]>();
  for (const entry of entries) {
    const file = rawFileFor(paths, entry.localDate);
    const line = `${JSON.stringify({
      id: entry.id,
      createdAt: entry.createdAt,
      fetchedAt,
      checkin: entry.checkin,
    })}\n`;
    const lines = byFile.get(file);
    if (lines) lines.push(line);
    else byFile.set(file, [line]);
  }

  for (const [file, lines] of byFile) {
    // A crash mid-append leaves a line with no newline on it. Appending
    // straight onto that would glue the next check-in to the fragment and lose
    // it — the record would be in the index but absent from the file the index
    // is rebuilt from, so it would vanish at the next reindex. One extra
    // newline isolates the damage to the torn line, which the reader skips.
    appendFileSync(file, `${endsMidLine(file) ? '\n' : ''}${lines.join('')}`, 'utf8');
  }
  return entries.length;
}

/** Whether a file exists and its last byte is not a newline. */
function endsMidLine(file: string): boolean {
  if (!existsSync(file)) return false;
  const { size } = statSync(file);
  if (size === 0) return false;

  const handle = openSync(file, 'r');
  try {
    const last = Buffer.alloc(1);
    readSync(handle, last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } finally {
    closeSync(handle);
  }
}

/** The monthly files present, oldest first. */
export function rawFiles(paths: ArchivePaths): readonly string[] {
  if (!existsSync(paths.rawDir)) return [];
  return readdirSync(paths.rawDir)
    .filter((name) => name.startsWith('checkins-') && name.endsWith('.jsonl'))
    .sort()
    .map((name) => join(paths.rawDir, name));
}

export interface ReadProblem {
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

/**
 * Streams every stored check-in, oldest month first.
 *
 * Line by line rather than by reading files whole: this is what a full re-index
 * runs over, and a decade of check-ins with photo metadata is large enough that
 * `JSON.parse(readFileSync(...))` on the biggest month is a real spike.
 *
 * A line that will not parse is reported through `onProblem` and skipped. One
 * torn line — the tail of an interrupted append — must not cost the rest of the
 * archive, and it is exactly the case an append-only file is prone to.
 */
export async function* readRaw(
  paths: ArchivePaths,
  onProblem?: (problem: ReadProblem) => void,
): AsyncGenerator<RawEntry> {
  for (const file of rawFiles(paths)) {
    const reader = createInterface({
      input: createReadStream(file, 'utf8'),
      crlfDelay: Infinity,
    });

    let lineNumber = 0;
    try {
      for await (const line of reader) {
        lineNumber += 1;
        if (line.trim() === '') continue;
        try {
          const parsed = JSON.parse(line) as Partial<RawEntry>;
          if (typeof parsed.id !== 'string' || typeof parsed.checkin !== 'object') {
            onProblem?.({ file, line: lineNumber, message: 'line is not a raw check-in entry' });
            continue;
          }
          yield {
            id: parsed.id,
            createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : 0,
            fetchedAt: typeof parsed.fetchedAt === 'string' ? parsed.fetchedAt : '',
            checkin: parsed.checkin as Record<string, unknown>,
          };
        } catch (error) {
          onProblem?.({
            file,
            line: lineNumber,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      reader.close();
    }
  }
}
