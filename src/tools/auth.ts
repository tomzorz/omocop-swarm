/**
 * Telling the caller about the credential, without ever handing it over.
 *
 * `authenticate` returns instructions rather than doing anything: a model
 * cannot open a browser, and the sign-in needs a human at one. It exists so
 * that a model asked to sync on an unconfigured machine can say precisely what
 * to run instead of reporting an opaque failure.
 */
import { z } from 'zod';
import { defineTool } from '../server/tool.js';
import type { TokenStore } from '../auth/token-store.js';

export function authTools(store: TokenStore) {
  const checkAuthStatus = defineTool({
    name: 'check-auth-status',
    title: 'Check the Foursquare sign-in',
    description:
      'Reports whether a Foursquare token is configured, where it came from, and — when one is ' +
      'present — whether Foursquare still accepts it. Everything that reads the local archive ' +
      'works without a token; only sync needs one.',
    requires: 'archive',
    annotations: { readOnlyHint: true },
    input: {
      verify: z
        .boolean()
        .default(true)
        .describe('Make one API call to confirm the token still works. Set false to stay offline.'),
    },
    output: {
      configured: z.boolean(),
      source: z.string().describe('Where the token was found: environment, file, or none.'),
      savedAt: z.string().nullable(),
      verified: z.boolean().nullable().describe('Null when no check was made.'),
      user: z.string().nullable().describe('The signed-in account, when verification succeeded.'),
      detail: z.string(),
    },
    handler: async (args, ctx) => {
      const source = store.source();
      const configured = source !== 'none';

      if (!configured) {
        return {
          configured: false,
          source,
          savedAt: null,
          verified: null,
          user: null,
          detail:
            'No token. Run `omocop-swarm auth` to sign in. The archive is still fully queryable.',
        };
      }

      if (!args.verify || !ctx.api) {
        return {
          configured: true,
          source,
          savedAt: store.savedAt() ?? null,
          verified: null,
          user: null,
          detail: 'A token is configured. It was not checked against Foursquare.',
        };
      }

      try {
        const response = await ctx.api.get<{ user?: { firstName?: string; lastName?: string } }>(
          'users/self',
        );
        const name = [response.user?.firstName, response.user?.lastName]
          .filter((part): part is string => typeof part === 'string' && part !== '')
          .join(' ');
        return {
          configured: true,
          source,
          savedAt: store.savedAt() ?? null,
          verified: true,
          user: name === '' ? null : name,
          detail: `Foursquare accepted the token${name === '' ? '' : ` for ${name}`}.`,
        };
      } catch (error) {
        // A failed verification is a result, not a tool failure: "your token
        // stopped working" is exactly what the caller asked to find out, and
        // throwing would report it as though the check itself had broken.
        return {
          configured: true,
          source,
          savedAt: store.savedAt() ?? null,
          verified: false,
          user: null,
          detail:
            `Foursquare rejected the token: ${error instanceof Error ? error.message : String(error)}. ` +
            'Run `omocop-swarm auth` to sign in again.',
        };
      }
    },
    render: (data) => {
      const lines = [data.detail, `Source: ${data.source}`];
      if (data.savedAt) lines.push(`Saved: ${data.savedAt}`);
      return lines.join('\n');
    },
  });

  const authenticate = defineTool({
    name: 'authenticate',
    title: 'How to sign in to Foursquare',
    description:
      'Returns the steps a human must take to sign this tool in to Foursquare. Signing in needs a ' +
      'browser, so this returns instructions rather than performing it. Use it when sync reports ' +
      'that no token is configured.',
    requires: 'archive',
    annotations: { readOnlyHint: true },
    input: {},
    output: {
      alreadyConfigured: z.boolean(),
      command: z.string(),
      redirectUri: z.string(),
      clientIdConfigured: z.boolean(),
      steps: z.array(z.string()),
    },
    handler: async (_args, ctx) => ({
      alreadyConfigured: store.source() !== 'none',
      command: 'omocop-swarm auth',
      redirectUri: ctx.config.redirectUri,
      clientIdConfigured: ctx.config.clientId !== undefined,
      steps: [
        'Register an application at https://foursquare.com/developers/apps (the check-in endpoints ' +
          'are part of the Personalization APIs, so accepting their EULA may be part of this).',
        `Set the application's redirect URI to exactly ${ctx.config.redirectUri}`,
        'Put its client id in .env next to the project as FOURSQUARE_CLIENT_ID.',
        'Run `omocop-swarm auth` in a terminal and open the URL it prints.',
        'Approve the app in the browser. The token is saved automatically; it is never shown in chat.',
      ],
    }),
    render: (data) =>
      [
        data.alreadyConfigured
          ? 'A token is already configured. These steps replace it.'
          : 'No token is configured yet.',
        '',
        ...data.steps.map((step, index) => `${index + 1}. ${step}`),
        '',
        data.clientIdConfigured
          ? 'FOURSQUARE_CLIENT_ID is set, so step 3 is done.'
          : 'FOURSQUARE_CLIENT_ID is not set yet.',
      ].join('\n'),
  });

  return [checkAuthStatus, authenticate];
}
