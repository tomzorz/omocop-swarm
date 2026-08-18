#!/usr/bin/env node
/**
 * omocop-swarm — the CLI surface over the same tools the MCP server exposes.
 *
 * No stdout guard here: CLI stdout is the product, not a JSON-RPC transport.
 * Logging still goes through the shared logger, to stderr, at LOG_LEVEL.
 *
 * The one subcommand that is not a tool is `auth`: signing in needs a browser
 * and a listening socket, neither of which belongs behind a tool handler.
 */
import { ConfigError, loadConfig, type Config } from '../config.js';
import { createLogger } from '../logging.js';
import { FoursquareClient } from '../foursquare/client.js';
import { TokenStore } from '../auth/token-store.js';
import { AuthServer } from '../auth/server.js';
import { runTool, type ToolContext } from '../server/tool.js';
import { Archive } from '../store/archive.js';
import { archivePaths } from '../store/paths.js';
import { toolGroups } from '../tools/all.js';
import { authHelp } from './help.js';
import { runCli } from './run.js';

async function main(): Promise<void> {
  // dotenv only fills gaps: an existing environment variable always wins over
  // the `.env` value of the same name, which is dotenv's default behaviour.
  const { config: dotenvConfig } = await import('dotenv');
  dotenvConfig();

  const logger = createLogger();
  const argv = process.argv.slice(2);

  // Configuration failures must not stop `--help` from working, so the error is
  // held and only raised when something actually needs the configuration.
  let configError: ConfigError | undefined;
  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    configError = error;
    config = loadConfig({});
  }

  const paths = archivePaths(config.dataDir);
  const store = new TokenStore(config, logger, paths.tokenPath);

  if (argv[0] === 'auth') {
    if (argv.includes('--help') || argv.includes('-h')) {
      process.stdout.write(authHelp());
      return;
    }
    if (configError) throw configError;
    await new AuthServer(config, logger, store).listen();
    process.stdout.write('Signed in. Run `omocop-swarm sync` to pull your check-in history.\n');
    return;
  }

  // Opening the archive creates directories, so it is deferred past `--help`
  // and past an unknown subcommand: neither should have a side effect on disk.
  let archive: Archive | undefined;

  try {
    process.exitCode = await runCli(argv, {
      groups: toolGroups(store),
      execute: async (definition, args) => {
        if (configError) throw configError;
        archive ??= Archive.open(config, logger);

        // The token is read per invocation: a CLI process is short-lived, and
        // the sign-in may have happened since the last run.
        const token = store.read();
        const context: ToolContext = {
          archive,
          api: token
            ? new FoursquareClient({
                endpoint: config.apiEndpoint,
                apiVersion: config.apiVersion,
                token,
                logger,
              })
            : undefined,
          config,
          logger,
          resolved: new Map(),
        };

        // runCli validated args against definition.input already; the erased
        // generics on AnyToolDefinition do not carry that through, hence the
        // cast — the same one the MCP registration makes.
        return runTool(definition, args as never, context);
      },
      stdout: (chunk) => void process.stdout.write(chunk),
      stderr: (chunk) => void process.stderr.write(chunk),
    });
  } finally {
    archive?.close();
  }
}

main().catch((error: unknown) => {
  const logger = createLogger();
  if (error instanceof ConfigError) {
    // A configuration problem is the user's to fix, and the message already
    // says how — no stack trace, which would only bury it.
    logger.error(error.message);
  } else {
    logger.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
});
