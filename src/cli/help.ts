/**
 * Help text. Asking for help is a success: it goes to stdout and exits 0.
 */
import type { AnyToolDefinition } from '../server/registry.js';
import type { ToolGroup } from '../tools/all.js';
import { flagSpecs, OUTPUT_FORMATS, type FlagSpec } from './flags.js';

export const BIN = 'omocop-swarm';

/**
 * Tools that exist to instruct an MCP model and have no place in a shell.
 * `authenticate` returns sign-in instructions a model relays; in a shell,
 * `omocop-swarm auth` starts the sign-in server directly.
 */
export const HIDDEN_TOOLS: ReadonlySet<string> = new Set(['authenticate']);

const AUTH_SUMMARY = 'Sign in to Foursquare; open the printed URL in a browser.';

const FORMAT_LINE = `  --format <${OUTPUT_FORMATS.join('|')}>      Output format. Default text. --json is shorthand.`;

/** The first sentence of a description — the summary a subcommand list shows. */
export const firstSentence = (description: string): string => {
  const match = /^[^.]*\./.exec(description);
  return (match ? match[0] : description).trim();
};

const entry = (name: string, summary: string): string => `  ${name.padEnd(20)}${summary}`;

export function globalHelp(groups: readonly ToolGroup[]): string {
  const lines: string[] = [
    `${BIN} — your Foursquare/Swarm check-in history, archived locally and queryable.`,
    '',
    'Usage:',
    `  ${BIN} <subcommand> [flags]`,
    `  ${BIN} <subcommand> --help`,
    '',
    'Global flags:',
    FORMAT_LINE,
  ];

  for (const group of groups) {
    lines.push('', `${group.area}:`);
    if (group.area === 'Authentication') lines.push(entry('auth', AUTH_SUMMARY));
    for (const tool of group.tools) {
      if (HIDDEN_TOOLS.has(tool.name)) continue;
      lines.push(entry(tool.name, firstSentence(tool.description)));
    }
  }

  lines.push(
    '',
    'Getting started:',
    `  ${BIN} auth              sign in once`,
    `  ${BIN} sync              pull the history (resumable; re-run to continue)`,
    `  ${BIN} list-checkins --from 2019-06-12`,
  );

  return `${lines.join('\n')}\n`;
}

export function toolHelp(tool: AnyToolDefinition): string {
  const specs = flagSpecs(tool.input);
  const lines: string[] = [
    `${BIN} ${tool.name} — ${firstSentence(tool.description)}`,
    '',
    tool.description,
    '',
    'Usage:',
    `  ${BIN} ${tool.name}${specs.length ? ' [flags]' : ''}`,
  ];

  if (specs.length) {
    lines.push('', 'Flags:');
    for (const spec of specs) lines.push(flagLine(spec));
  }

  lines.push('', 'Global flags:', FORMAT_LINE);
  return `${lines.join('\n')}\n`;
}

export function authHelp(): string {
  return (
    [
      `${BIN} auth — ${AUTH_SUMMARY}`,
      '',
      'Reads configuration from the environment and from .env in the working directory',
      '(a real environment variable wins), then listens on http://localhost:<SWARM_AUTH_PORT>',
      '(default 3535) until you have signed in or ten minutes pass.',
      '',
      'The token is written to token.json inside the archive directory, which is where',
      'the MCP server looks for it — an MCP server is launched by its client and never',
      'sees your shell environment or your .env.',
    ].join('\n') + '\n'
  );
}

function flagLine(spec: FlagSpec): string {
  const value =
    spec.kind === 'boolean'
      ? ''
      : spec.choices
        ? ` <${spec.choices.join('|')}>`
        : ` <${spec.kind === 'array' ? spec.element : spec.kind}>`;

  const marks: string[] = [];
  if (spec.required) marks.push('required');
  if (spec.kind === 'array') marks.push('repeatable');
  if (spec.kind === 'boolean') marks.push('bare means true; =false means false');
  const suffix = marks.length ? ` (${marks.join('; ')})` : '';

  const head = `  --${spec.flag}${value}`;
  const description = spec.description ?? '';
  const tail = `${description}${suffix}`.trim();
  return tail ? `${head.padEnd(30)}${tail}` : head;
}
