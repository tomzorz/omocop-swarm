#!/usr/bin/env node
/**
 * omocop-swarm — an MCP server over a local archive of your Foursquare/Swarm
 * check-ins.
 *
 * Startup order matters here. The stdout guard goes in before anything else can
 * write, because stdio is the transport and a single stray byte on stdout
 * breaks the protocol in a way that never points at its cause.
 *
 * Note what this server does *not* need: an MCP client launches it with no
 * shell environment, so the token comes from `token.json` in the archive
 * directory rather than from `.env`. That is why `omocop-swarm auth` writes it
 * there, and why every tool but `sync` works whether or not it exists.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { ConfigError, loadConfig } from './config.js';
import { createLogger, installStdoutGuard } from './logging.js';
import { FoursquareClient } from './foursquare/client.js';
import { TokenStore } from './auth/token-store.js';
import { registerTools, type AnyToolDefinition } from './server/registry.js';
import type { ToolContext } from './server/tool.js';
import { Archive } from './store/archive.js';
import { archivePaths } from './store/paths.js';
import { allTools } from './tools/all.js';

const SERVER_NAME = 'omocop-swarm';
const SERVER_VERSION = '1.0.0';

const booleanish = (value: string | undefined): boolean =>
  value !== undefined && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());

export async function main(): Promise<void> {
  const logger = createLogger();
  installStdoutGuard(logger);

  const config = loadConfig();
  const store = new TokenStore(config, logger, archivePaths(config.dataDir).tokenPath);
  const archive = Archive.open(config, logger);

  const token = store.read();
  if (!token) {
    logger.info(
      'No Foursquare token found. Every tool that reads the archive still works; ' +
        'run `omocop-swarm auth` to enable syncing.',
    );
  }

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

  const tools: AnyToolDefinition[] = allTools(store);
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  const report = registerTools(server, tools, context, {
    hasToken: token !== undefined,
    hideUnavailable: booleanish(process.env['SWARM_HIDE_UNAVAILABLE_TOOLS']),
    logger,
  });

  logger.info(
    `${SERVER_NAME} ${SERVER_VERSION} ready with ${report.registered.length} tool(s)` +
      `${report.hidden.length ? `, ${report.hidden.length} hidden` : ''}, ` +
      `archive at ${archive.paths.root} holding ${archive.index.count()} check-in(s).`,
  );

  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  const logger = createLogger();

  if (error instanceof ConfigError) {
    // A configuration problem is the user's to fix, and the message already
    // says how — no stack trace, which would only bury it.
    logger.error(error.message);
  } else {
    logger.error('Failed to start', error);
  }

  process.exitCode = 1;
});
