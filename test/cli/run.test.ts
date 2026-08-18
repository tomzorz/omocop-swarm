import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runCli, type CliDeps } from '../../src/cli/run.js';
import { defineTool, type ToolResult } from '../../src/server/tool.js';
import type { ToolGroup } from '../../src/tools/all.js';

const listThings = defineTool({
  name: 'list-things',
  description: 'Lists the things. A description long enough to have a first sentence and a rest.',
  requires: 'archive',
  input: {
    from: z.string().optional().describe('First day.'),
    limit: z.number().int().default(10).describe('How many.'),
  },
  output: { things: z.array(z.string()), total: z.number() },
  handler: async () => ({ things: ['one'], total: 1 }),
  render: (data) => `${data.total} thing(s): ${data.things.join(', ')}`,
});

const groups: readonly ToolGroup[] = [
  { area: 'Things', tools: [listThings] },
  { area: 'Authentication', tools: [] },
];

interface Capture {
  out: string;
  err: string;
}

const run = async (
  argv: readonly string[],
  execute: CliDeps['execute'] = async () => ({
    content: [{ type: 'text', text: '1 thing(s): one' }],
    structuredContent: { things: ['one'], total: 1 },
  }),
): Promise<Capture & { code: number }> => {
  const capture: Capture = { out: '', err: '' };
  const code = await runCli(argv, {
    groups,
    execute,
    stdout: (chunk) => (capture.out += chunk),
    stderr: (chunk) => (capture.err += chunk),
  });
  return { ...capture, code };
};

describe('help', () => {
  it('is a success and goes to stdout', async () => {
    const result = await run(['--help']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('list-things');
    expect(result.err).toBe('');
  });

  it('lists `auth` under Authentication even though it is not a tool', async () => {
    expect((await run(['--help'])).out).toContain('auth ');
  });

  it('shows per-tool help with its flags', async () => {
    const result = await run(['list-things', '--help']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('--from');
    expect(result.out).toContain('First day.');
    expect(result.out).toContain('--limit');
  });

  it('does not run the tool when help was asked for', async () => {
    let ran = false;
    await run(['list-things', '--help'], async () => {
      ran = true;
      return { content: [] };
    });
    expect(ran).toBe(false);
  });
});

describe('dispatch', () => {
  it('runs a tool and prints its rendered text', async () => {
    const result = await run(['list-things']);
    expect(result.code).toBe(0);
    expect(result.out.trim()).toBe('1 thing(s): one');
  });

  it('prints the structured content for --json and nothing else', async () => {
    const result = await run(['list-things', '--json']);
    expect(JSON.parse(result.out)).toEqual({ things: ['one'], total: 1 });
  });

  it('passes validated arguments through, defaults included', async () => {
    let seen: Record<string, unknown> = {};
    await run(['list-things', '--from', '2019-06-12'], async (_definition, args) => {
      seen = args;
      return { content: [{ type: 'text', text: 'ok' }] };
    });
    expect(seen).toEqual({ from: '2019-06-12', limit: 10 });
  });
});

describe('exit codes', () => {
  it('exits 2 with no subcommand', async () => {
    const result = await run([]);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/Usage:/);
    expect(result.out).toBe('');
  });

  it('exits 2 for an unknown subcommand and names it', async () => {
    const result = await run(['frobnicate']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('frobnicate');
    expect(result.out).toBe('');
  });

  it('exits 2 for an unknown flag', async () => {
    const result = await run(['list-things', '--nope']);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/Unknown flag/);
  });

  it('exits 2 when validation fails, naming the flag', async () => {
    const result = await run(['list-things', '--limit', 'lots']);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/--limit/);
  });

  it('exits 1 when the tool returns an error result, and says so on stderr', async () => {
    const failing: ToolResult = { content: [{ type: 'text', text: 'no token' }], isError: true };
    const result = await run(['list-things'], async () => failing);
    expect(result.code).toBe(1);
    expect(result.err).toContain('no token');
    expect(result.out).toBe('');
  });

  it('exits 1 when the environment itself fails, without a stack trace', async () => {
    const result = await run(['list-things'], async () => {
      throw new Error('configuration is missing');
    });
    expect(result.code).toBe(1);
    expect(result.err.trim()).toBe('configuration is missing');
  });

  it('writes nothing to stdout on any failure, so a JSON consumer sees a clean stream', async () => {
    for (const argv of [[], ['frobnicate'], ['list-things', '--nope']]) {
      expect((await run(argv)).out).toBe('');
    }
  });
});
