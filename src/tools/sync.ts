/**
 * Fetching, re-indexing, and reporting on the state of the archive.
 *
 * `sync` is the only tool in the project that reaches Foursquare. Everything
 * else answers from disk, which is why it is the only one declaring
 * `requires: 'api'` — and why the archive stays fully queryable on a machine
 * that has never been signed in.
 */
import { z } from 'zod';
import { humanDuration } from '../domain/time.js';
import { defineTool } from '../server/tool.js';
import { reindex } from '../sync/reindex.js';
import { sync as runSync } from '../sync/run.js';
import { readState } from '../store/state.js';
import { rawFiles } from '../store/raw.js';

const syncTool = defineTool({
  name: 'sync',
  title: 'Sync check-ins from Foursquare',
  description:
    'Fetches check-ins from Foursquare into the local archive. Incremental by default: it walks ' +
    'down from the newest until it reaches something already archived, then continues any ' +
    'unfinished backfill of the older history. Safe to re-run and safe to interrupt — the position ' +
    'is saved after every page, so a killed run resumes rather than restarting. This is the only ' +
    'tool that contacts Foursquare, and it only ever reads.',
  requires: 'api',
  annotations: { readOnlyHint: false, idempotentHint: true },
  input: {
    full: z
      .boolean()
      .default(false)
      .describe('Re-walk the entire history instead of stopping at the newest archived check-in.'),
    maxPages: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Stop after this many API requests. The run stays resumable.'),
    reprobe: z
      .boolean()
      .default(false)
      .describe('Re-test which undocumented paging parameters the API honours.'),
  },
  output: {
    added: z.number().describe('Check-ins the archive had never seen.'),
    refreshed: z.number().describe('Check-ins re-fetched and updated in place.'),
    fetched: z.number(),
    pages: z.number().describe('API requests made.'),
    storedTotal: z.number(),
    remoteCount: z.number().nullable().describe('Total Foursquare reports for the account.'),
    backfillComplete: z.boolean(),
    stoppedEarly: z.boolean(),
    phases: z.array(z.string()),
    durationSeconds: z.number(),
    notes: z.array(z.string()),
  },
  handler: async (args, ctx) => {
    if (!ctx.api) throw new Error('unreachable: the requirement gate guarantees a client');

    const result = await runSync(
      {
        client: ctx.api,
        index: ctx.archive.index,
        paths: ctx.archive.paths,
        logger: ctx.logger,
        apiVersion: ctx.config.apiVersion,
      },
      {
        pageSize: ctx.config.pageSize,
        full: args.full,
        ...(args.maxPages !== undefined ? { maxPages: args.maxPages } : {}),
        reprobe: args.reprobe,
      },
    );

    return {
      added: result.added,
      refreshed: result.refreshed,
      fetched: result.fetched,
      pages: result.pages,
      storedTotal: result.storedTotal,
      remoteCount: result.remoteCount ?? null,
      backfillComplete: result.backfillComplete,
      stoppedEarly: result.stoppedEarly,
      phases: [...result.phasesRun],
      durationSeconds: Math.round(result.durationMs / 100) / 10,
      notes: [...result.notes],
    };
  },
  render: (data) => {
    const lines = [
      data.added === 0 && data.refreshed === 0
        ? 'Already up to date.'
        : `${data.added} new check-in${data.added === 1 ? '' : 's'}` +
          `${data.refreshed > 0 ? `, ${data.refreshed} refreshed` : ''}.`,
      `The archive holds ${data.storedTotal}` +
        `${data.remoteCount !== null ? ` of ${data.remoteCount} reported by Foursquare` : ''}.`,
      `${data.pages} request${data.pages === 1 ? '' : 's'} in ${data.durationSeconds}s.`,
    ];
    if (!data.backfillComplete) {
      lines.push(
        data.stoppedEarly
          ? 'The backfill stopped at the page limit. Run sync again to continue from here.'
          : 'The backfill of older check-ins is not finished. Run sync again to continue.',
      );
    }
    return [...lines, ...data.notes.map((note) => `\n${note}`)].join('\n').trimEnd();
  },
});

const syncStatus = defineTool({
  name: 'sync-status',
  title: 'Archive and sync status',
  description:
    'Reports what the archive holds, when it was last synced, whether the backfill of older ' +
    'check-ins finished, and which undocumented API paging parameters were found to work. Reads ' +
    'local files only and needs no token — use it to find out whether a sync is needed before ' +
    'running one.',
  requires: 'archive',
  annotations: { readOnlyHint: true },
  input: {},
  output: {
    dataDir: z.string(),
    stored: z.number(),
    remoteCount: z.number().nullable(),
    oldest: z.string().nullable(),
    newest: z.string().nullable(),
    lastSyncFinishedAt: z.string().nullable(),
    backfillComplete: z.boolean(),
    backfillOffset: z.number(),
    rawFileCount: z.number(),
    hasToken: z.boolean(),
    capabilities: z
      .object({
        afterTimestamp: z.boolean(),
        beforeTimestamp: z.boolean(),
        sortOldestFirst: z.boolean(),
        probedAt: z.string(),
      })
      .nullable(),
    notes: z.array(z.string()),
  },
  handler: async (_args, ctx) => {
    const state = readState(ctx.archive.paths, (warning) => ctx.logger.warn(warning));
    const summary = ctx.archive.index.summary();
    const caveat = ctx.archive.caveat();

    return {
      dataDir: ctx.archive.paths.root,
      stored: summary.total,
      remoteCount: state.remoteCount ?? null,
      oldest: summary.firstCheckin,
      newest: summary.lastCheckin,
      lastSyncFinishedAt: state.lastSyncFinishedAt ?? null,
      backfillComplete: state.backfill.complete,
      backfillOffset: state.backfill.offset,
      rawFileCount: rawFiles(ctx.archive.paths).length,
      hasToken: ctx.api !== undefined,
      capabilities: state.capabilities
        ? {
            afterTimestamp: state.capabilities.afterTimestamp,
            beforeTimestamp: state.capabilities.beforeTimestamp,
            sortOldestFirst: state.capabilities.sortOldestFirst,
            probedAt: state.capabilities.probedAt,
          }
        : null,
      notes: caveat ? [caveat] : [],
    };
  },
  render: (data) => {
    const lines = [
      `Archive at ${data.dataDir}`,
      `  ${data.stored} check-in${data.stored === 1 ? '' : 's'} across ${data.rawFileCount} monthly file(s)` +
        `${data.remoteCount !== null ? `, Foursquare reports ${data.remoteCount}` : ''}`,
    ];
    if (data.oldest && data.newest) lines.push(`  spanning ${data.oldest} to ${data.newest}`);
    lines.push(
      `  last sync: ${data.lastSyncFinishedAt ?? 'never'}`,
      `  backfill: ${data.backfillComplete ? 'complete' : `in progress, at offset ${data.backfillOffset}`}`,
      `  token: ${data.hasToken ? 'configured' : 'not configured — sync is unavailable'}`,
    );
    if (data.capabilities) {
      const works = (value: boolean): string => (value ? 'works' : 'ignored');
      lines.push(
        `  API paging: afterTimestamp ${works(data.capabilities.afterTimestamp)}, ` +
          `beforeTimestamp ${works(data.capabilities.beforeTimestamp)}, ` +
          `sort=oldestfirst ${works(data.capabilities.sortOldestFirst)}`,
      );
    }
    if (data.remoteCount !== null && data.stored < data.remoteCount && data.backfillComplete) {
      lines.push(
        `\nThe archive is ${data.remoteCount - data.stored} behind. Run \`omocop-swarm sync --full\`.`,
      );
    }
    return [...lines, ...data.notes.map((note) => `\n${note}`)].join('\n').trimEnd();
  },
});

const reindexTool = defineTool({
  name: 'reindex',
  title: 'Rebuild the index from the raw archive',
  description:
    'Rebuilds the SQLite index from the raw JSONL files. The raw files are the archive; the index ' +
    'is a projection of them, so this repairs a damaged or out-of-date index, and applies any ' +
    'change to how check-ins are parsed, without contacting Foursquare. Nothing archived is lost ' +
    'by running it.',
  requires: 'archive',
  annotations: { readOnlyHint: false, idempotentHint: true },
  input: {},
  output: {
    indexed: z.number(),
    linesRead: z.number(),
    duplicates: z.number().describe('Lines superseded by a later copy of the same check-in.'),
    skipped: z.array(z.object({ where: z.string(), message: z.string() })),
    durationSeconds: z.number(),
  },
  handler: async (_args, ctx) => {
    const result = await reindex(ctx.archive.paths, ctx.archive.index, ctx.logger);
    return {
      indexed: result.indexed,
      linesRead: result.linesRead,
      duplicates: result.duplicates,
      skipped: result.skipped.map((entry) => ({ where: entry.where, message: entry.message })),
      durationSeconds: Math.round(result.durationMs / 100) / 10,
    };
  },
  render: (data) => {
    const lines = [
      `Indexed ${data.indexed} check-in${data.indexed === 1 ? '' : 's'} from ${data.linesRead} line(s) ` +
        `in ${humanDuration(data.durationSeconds)}.`,
    ];
    if (data.duplicates > 0) {
      lines.push(`${data.duplicates} line(s) were superseded by a later copy of the same check-in.`);
    }
    if (data.skipped.length > 0) {
      lines.push('', `${data.skipped.length} line(s) skipped:`);
      for (const entry of data.skipped.slice(0, 20)) {
        lines.push(`  ${entry.where}: ${entry.message}`);
      }
      if (data.skipped.length > 20) lines.push(`  ... and ${data.skipped.length - 20} more.`);
    }
    if (data.indexed === 0 && data.linesRead === 0) {
      lines.push('', 'There are no raw files yet. Run `omocop-swarm sync` first.');
    }
    return lines.join('\n');
  },
});

export const syncTools = [syncTool, syncStatus, reindexTool];
