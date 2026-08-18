/**
 * The escape hatch.
 *
 * Every other tool answers a question somebody anticipated. This one exists
 * because a decade of location history invites questions nobody did — the
 * longest gap between two visits to the same place, the venues only ever
 * checked into on a Tuesday, whatever.
 *
 * Its safety is not a pattern match over the statement. `CheckinIndex.query`
 * opens a second connection in SQLite's own read-only mode, so a statement that
 * tries to write is refused by the engine. A blocklist of keywords would be a
 * thing to keep correct forever; a read-only file descriptor is a fact.
 */
import { z } from 'zod';
import { CheckinIndex } from '../store/index-db.js';
import { defineTool, ToolRefusal } from '../server/tool.js';

const NO_INDEX =
  'There is no archive index yet. Run `omocop-swarm sync` to fetch your history, ' +
  'or `omocop-swarm reindex` if the raw files already exist.';

const queryArchive = defineTool({
  name: 'query-archive',
  title: 'Run a read-only SQL query over the archive',
  description:
    'Runs a SELECT against the archive index and returns the rows. For questions the other tools ' +
    'do not cover. The connection is opened read-only, so nothing can be modified. Call ' +
    'archive-schema first to see the tables and columns; note that times are stored as local_ts, ' +
    'a wall clock encoded as seconds, alongside created_at, which is a real UTC instant.',
  requires: 'archive',
  annotations: { readOnlyHint: true },
  input: {
    sql: z.string().min(1).describe('A SELECT statement. Anything that writes is refused.'),
    limit: z.number().int().min(1).max(1000).default(200).describe('Maximum rows to return.'),
  },
  output: {
    rows: z.array(z.record(z.unknown())),
    rowCount: z.number(),
    truncated: z.boolean(),
  },
  handler: async (args, ctx) => {
    if (!ctx.archive.indexExists) throw new ToolRefusal(NO_INDEX);

    let result: ReturnType<typeof CheckinIndex.query>;
    try {
      result = CheckinIndex.query(ctx.archive.paths.indexPath, args.sql, args.limit);
    } catch (error) {
      // SQLite rejecting a statement is an answer, not a malfunction. Reported
      // as a refusal so the caller gets the reason without a stack trace on top
      // of it — and, for a write, so the reason names the actual rule.
      const message = error instanceof Error ? error.message : String(error);
      throw new ToolRefusal(
        /readonly database/i.test(message)
          ? 'That statement writes, and this connection is opened read-only. ' +
            'query-archive answers questions; it cannot change the archive.'
          : `SQLite rejected that statement: ${message}\n\n` +
            'Run archive-schema to see the tables and columns that exist.',
      );
    }

    return {
      rows: result.rows as Array<Record<string, unknown>>,
      rowCount: result.rows.length,
      truncated: result.truncated,
    };
  },
  render: (data) => {
    if (data.rowCount === 0) return 'The query returned no rows.';
    return [
      table(data.rows),
      '',
      `${data.rowCount} row${data.rowCount === 1 ? '' : 's'}` +
        `${data.truncated ? ' (truncated — raise limit for more)' : ''}.`,
    ].join('\n');
  },
});

const archiveSchema = defineTool({
  name: 'archive-schema',
  title: 'Describe the archive index',
  description:
    'Lists the tables and columns of the archive index, so a query can be written against what is ' +
    'actually there rather than what seems likely. Pair it with query-archive.',
  requires: 'archive',
  annotations: { readOnlyHint: true },
  input: {},
  output: {
    tables: z.array(z.object({ table: z.string(), columns: z.array(z.string()) })),
  },
  handler: async (_args, ctx) => {
    if (!ctx.archive.indexExists) throw new ToolRefusal(NO_INDEX);
    return {
      tables: CheckinIndex.schema(ctx.archive.paths.indexPath).map((entry) => ({
        table: entry.table,
        columns: [...entry.columns],
      })),
    };
  },
  render: (data) =>
    data.tables.map((entry) => `${entry.table}\n  ${entry.columns.join(', ')}`).join('\n\n'),
});

/** A fixed-width table. Values are stringified once and measured once. */
function table(rows: ReadonlyArray<Record<string, unknown>>): string {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const cell = (value: unknown): string =>
    value === null || value === undefined
      ? ''
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);

  const widths = columns.map((column) =>
    Math.max(column.length, ...rows.map((row) => cell(row[column]).length)),
  );
  const line = (values: readonly string[]): string =>
    values.map((value, index) => value.padEnd(widths[index] ?? 0)).join('  ').trimEnd();

  return [
    line(columns),
    line(widths.map((width) => '-'.repeat(width))),
    ...rows.map((row) => line(columns.map((column) => cell(row[column])))),
  ].join('\n');
}

export const sqlTools = [queryArchive, archiveSchema];
