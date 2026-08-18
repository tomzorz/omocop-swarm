/**
 * The tool harness.
 *
 * A tool declares what it is and what it needs; everything a tool would
 * otherwise repeat happens here, once.
 *
 * The repetition being eliminated is not hypothetical. Written by hand, every
 * handler carries the same preamble — validate, check the token, try,
 * translate, wrap — and the copies drift. One tool grows a helpful message for
 * a missing token while its neighbours emit a bare status line, and which is
 * which is an accident of when each was last touched.
 *
 * Three consequences worth naming:
 *
 *   - **Error semantics are uniform** because there is one catch block.
 *   - **Prose and structured data cannot disagree**, because the handler
 *     returns data and `render` derives the text from it. Two hand-written
 *     outputs would drift the same way the preamble did.
 *   - **Cross-cutting rules are declared, not remembered.** A policy runs
 *     before the handler, so a handler cannot be reached in a state the policy
 *     forbids.
 */
import type { z, ZodRawShape } from 'zod';
import { z as zod } from 'zod';
import type { Config } from '../config.js';
import { MISSING_TOKEN_MESSAGE } from '../config.js';
import type { Logger } from '../logging.js';
import type { FoursquareClient } from '../foursquare/client.js';
import { FoursquareError, describeApiError } from '../foursquare/errors.js';
import type { Archive } from '../store/archive.js';

/**
 * What a tool needs in order to work.
 *
 * The distinction that matters in this project is not permissions — a
 * Foursquare user token is all or nothing — but reach. Almost everything here
 * answers from local files and works with no credential at all; only sync
 * touches the network. Declaring which is which lets a tool that cannot
 * possibly work say so before it tries, and lets the archive stay fully
 * queryable on a machine that has never been signed in.
 */
export type Requirement = 'archive' | 'api';

/** Everything a handler is given. */
export interface ToolContext {
  readonly archive: Archive;
  /** Present only when a token is configured. Tools requiring 'api' can rely on it. */
  readonly api: FoursquareClient | undefined;
  readonly config: Config;
  readonly logger: Logger;
  /**
   * Values contributed by policies, keyed by the policy that produced them.
   * Policies export typed accessors rather than exposing callers to the bag.
   */
  readonly resolved: Map<symbol, unknown>;
}

/** What a policy decides. */
export type PolicyOutcome =
  /** Stop; the message is returned to the caller and the handler never runs. */
  | { readonly refuse: string }
  /** Continue, optionally contributing a value to the context. */
  | { readonly proceed: true; readonly key?: symbol; readonly value?: unknown };

/**
 * A rule applied before the handler.
 *
 * Policies exist so a rule that applies to several tools is stated once and
 * enforced by the machinery, rather than reimplemented in each handler and
 * extracted after the third copy.
 */
export type ToolPolicy<TArgs = Record<string, unknown>> = (
  args: TArgs,
  ctx: ToolContext,
) => Promise<PolicyOutcome> | PolicyOutcome;

type Infer<T extends ZodRawShape> = z.infer<z.ZodObject<T>>;

export interface ToolDefinition<In extends ZodRawShape, Out extends ZodRawShape> {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly requires: Requirement;
  readonly input: In;
  readonly output: Out;
  readonly annotations?: {
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
  };
  readonly policies?: readonly ToolPolicy<Infer<In>>[];
  readonly handler: (args: Infer<In>, ctx: ToolContext) => Promise<Infer<Out>>;
  /**
   * Derives what the caller sees from the same data returned as structured
   * output, so the two cannot disagree.
   */
  readonly render: (data: Infer<Out>) => string;
}

/**
 * Identity function that fixes the generic parameters.
 *
 * Without it, a definition written inline widens `input`/`output` to
 * `ZodRawShape` and the handler loses its argument types.
 */
export function defineTool<In extends ZodRawShape, Out extends ZodRawShape>(
  definition: ToolDefinition<In, Out>,
): ToolDefinition<In, Out> {
  return definition;
}

/**
 * A refusal caused by what was asked for, rather than by anything being broken.
 *
 * The distinction is about who reads the output. A genuine bug is logged with
 * its stack, because somebody has to fix it. Invalid SQL, or a query against an
 * archive that has not been built yet, is the caller's to correct — and a stack
 * trace on top of the explanation buries the explanation.
 *
 * A policy is the better home for a rule known before the handler runs. This is
 * for the ones that can only be discovered by trying, which is most of what
 * SQLite has to say.
 */
export class ToolRefusal extends Error {
  override readonly name = 'ToolRefusal';
}

export interface ContentBlock {
  readonly type: 'text';
  readonly text: string;
}

/** The subset of an MCP tool result this harness produces. */
export interface ToolResult {
  readonly content: readonly ContentBlock[];
  readonly structuredContent?: Record<string, unknown>;
  readonly isError?: boolean;
}

const ok = (rendered: string, data: Record<string, unknown>): ToolResult => ({
  content: [{ type: 'text', text: rendered }],
  structuredContent: data,
});

const fail = (text: string): ToolResult => ({
  content: [{ type: 'text', text }],
  isError: true,
});

/** Whether the current configuration can satisfy a tool's requirement. */
export const satisfied = (requirement: Requirement, hasToken: boolean): boolean =>
  requirement === 'archive' || hasToken;

/** Runs one tool call end to end. */
export async function runTool<In extends ZodRawShape, Out extends ZodRawShape>(
  definition: ToolDefinition<In, Out>,
  args: Infer<In>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const { name } = definition;
  const { logger } = ctx;

  // The requirement gate answers a static question statically. Reaching the API
  // to be told the token is missing costs a round trip and produces a worse
  // message — and here there is no token to send at all.
  if (!satisfied(definition.requires, ctx.api !== undefined)) {
    logger.debug(`${name} refused: no token configured`);
    return fail(MISSING_TOKEN_MESSAGE);
  }

  try {
    for (const policy of definition.policies ?? []) {
      const outcome = await policy(args, ctx);
      if ('refuse' in outcome) {
        logger.debug(`${name} refused by policy`);
        return fail(outcome.refuse);
      }
      if (outcome.key !== undefined) ctx.resolved.set(outcome.key, outcome.value);
    }

    const data = await definition.handler(args, ctx);

    // Validating the handler's own output catches a mismatch here, naming the
    // tool, rather than as an opaque protocol error at the client.
    const parsed = zod.object(definition.output).safeParse(data);
    if (!parsed.success) {
      logger.error(`${name} returned data that does not match its output schema`, parsed.error);
      return fail(
        `${name} produced a malformed result. This is a bug in the server, not in the request.`,
      );
    }

    // Render from the parsed data, not the raw handler output: parsing strips
    // extra keys and applies defaults, and the text must describe exactly what
    // the structured content carries.
    return ok(definition.render(parsed.data as Infer<Out>), parsed.data as Record<string, unknown>);
  } catch (error) {
    if (error instanceof ToolRefusal) {
      logger.debug(`${name} refused: ${error.message}`);
      return fail(error.message);
    }

    if (error instanceof FoursquareError) {
      logger.warn(`${name} failed: ${error.message}`);
      return fail(describeApiError(error));
    }

    logger.error(`${name} threw`, error);
    return fail(error instanceof Error ? error.message : String(error));
  }
}
