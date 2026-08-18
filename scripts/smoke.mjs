#!/usr/bin/env node
/**
 * Starts the built server, speaks MCP to it over stdio, and checks the things
 * unit tests cannot:
 *
 *   1. It boots and completes a handshake.
 *   2. **stdout carries nothing but JSON-RPC frames.** A stray write there
 *      breaks the transport, and the failure never points at whatever wrote it
 *      — so this is checked against a real process rather than assumed.
 *   3. The CLI bin dispatches, exits with the promised codes, and keeps its
 *      stdout and stderr apart.
 *
 * Needs no credentials and no archive: it never reaches Foursquare, and it
 * points the data directory at a throwaway path.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TIMEOUT_MS = 15_000;
const dataDir = mkdtempSync(join(tmpdir(), 'omocop-swarm-smoke-'));

const env = {
  ...process.env,
  SWARM_DATA_DIR: dataDir,
  FOURSQUARE_TOKEN: '',
  LOG_LEVEL: 'info',
};

const child = spawn(process.execPath, ['dist/index.js'], {
  env,
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => (stdout += chunk));
child.stderr.on('data', (chunk) => (stderr += chunk));

const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);

send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '1.0.0' },
  },
});

setTimeout(() => {
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  send({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'sync-status', arguments: {} },
  });
  send({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'sync', arguments: {} },
  });
}, 500);

const failures = [];
const check = (ok, description) => {
  if (!ok) failures.push(description);
  process.stderr.write(`${ok ? 'ok  ' : 'FAIL'}  ${description}\n`);
};

/** Spawns the built CLI once, as a real process. */
const runCliOnce = (args) =>
  new Promise((resolve) => {
    const cli = spawn(process.execPath, ['dist/cli/index.js', ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    cli.stdout.on('data', (chunk) => (out += chunk));
    cli.stderr.on('data', (chunk) => (err += chunk));
    cli.on('close', (code) => resolve({ code, out, err }));
  });

async function cliChecks() {
  const help = await runCliOnce(['--help']);
  check(help.code === 0, 'cli --help exits 0');
  for (const name of ['auth', 'sync', 'list-checkins', 'query-archive', 'checkins-near']) {
    check(help.out.includes(name), `cli --help lists ${name}`);
  }
  check(!/^\s{2}authenticate\b/m.test(help.out), 'cli --help hides the authenticate tool');

  const unknown = await runCliOnce(['frobnicate']);
  check(unknown.code === 2, 'cli unknown subcommand exits 2');
  check(unknown.err.includes('frobnicate'), 'cli unknown subcommand names itself on stderr');
  check(unknown.out === '', 'cli unknown subcommand writes nothing to stdout');

  const status = await runCliOnce(['sync-status', '--json']);
  check(status.code === 0, 'cli sync-status exits 0 with no token');
  let parsed;
  try {
    parsed = JSON.parse(status.out);
  } catch {
    parsed = undefined;
  }
  check(parsed !== undefined, 'cli --json emits parseable JSON on stdout');
  check(parsed?.hasToken === false, 'cli sync-status reports no token');

  const needsToken = await runCliOnce(['sync']);
  check(needsToken.code === 1, 'cli sync without a token exits 1');
  check(needsToken.out === '', 'cli sync without a token writes nothing to stdout');
  check(/omocop-swarm auth/.test(needsToken.err), 'cli sync without a token says how to fix it');

  const badDate = await runCliOnce(['list-checkins', '--from', '12/06/2019']);
  check(badDate.code === 2, 'cli rejects a malformed date with exit 2');
}

setTimeout(async () => {
  child.kill();

  const lines = stdout.trim().split('\n').filter(Boolean);
  const parsed = [];
  let unparseable = 0;

  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line));
    } catch {
      unparseable += 1;
      process.stderr.write(`  stray stdout line: ${line.slice(0, 120)}\n`);
    }
  }

  check(unparseable === 0, 'stdout contains only parseable JSON');
  check(
    parsed.every((message) => message.jsonrpc === '2.0'),
    'every stdout line is a JSON-RPC frame',
  );

  const initialize = parsed.find((message) => message.id === 1);
  check(initialize?.result?.serverInfo?.name === 'omocop-swarm', 'handshake names the server');

  const list = parsed.find((message) => message.id === 2);
  const toolList = list?.result?.tools ?? [];
  check(toolList.length > 10, `tools/list returned tools (${toolList.length})`);
  check(
    toolList.every((tool) => tool.inputSchema && tool.outputSchema),
    'every tool advertises both schemas',
  );
  check(
    toolList.every((tool) => typeof tool.description === 'string' && tool.description.length > 80),
    'every tool advertises a description a model can pick from',
  );

  const status = parsed.find((message) => message.id === 3);
  check(status?.result?.structuredContent !== undefined, 'sync-status returns structured content');
  check(status?.result?.isError !== true, 'sync-status works with no token');

  const sync = parsed.find((message) => message.id === 4);
  check(sync?.result?.isError === true, 'sync refuses without a token');
  check(
    JSON.stringify(sync?.result ?? {}).includes('omocop-swarm auth'),
    'sync says how to get a token',
  );

  check(stderr.includes('ready with'), 'startup was logged to stderr');
  check(!stderr.includes('Failed to start'), 'startup did not fail');

  await cliChecks();

  rmSync(dataDir, { recursive: true, force: true });

  if (failures.length > 0) {
    process.stderr.write(`\n${failures.length} check(s) failed\n`);
    process.exitCode = 1;
  } else {
    process.stderr.write('\nsmoke test passed\n');
  }
}, 2000);

setTimeout(() => {
  child.kill();
  rmSync(dataDir, { recursive: true, force: true });
  process.stderr.write('smoke test timed out\n');
  process.exitCode = 1;
}, TIMEOUT_MS).unref();
