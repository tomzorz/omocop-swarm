/**
 * Where the token comes from, and where `auth` puts it.
 *
 * Two sources, in this order:
 *
 *   1. `FOURSQUARE_TOKEN` in the environment
 *   2. `token.json` in the archive directory, written by `omocop-swarm auth`
 *
 * The file exists because of the trap that catches every MCP server: the server
 * is launched by its client, not by a shell, so it inherits no environment and
 * reads no `.env`. Requiring the token in the environment would mean pasting it
 * into an MCP client config. Writing it next to the archive it unlocks means
 * `omocop-swarm auth` once, and the server finds it.
 *
 * The environment still wins where it is set, because a value stated explicitly
 * for a process should beat a file that process merely happens to find.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { Config } from '../config.js';
import type { Logger } from '../logging.js';

export type TokenSource = 'environment' | 'file' | 'none';

interface StoredToken {
  readonly token: string;
  readonly savedAt: string;
}

export class TokenStore {
  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly tokenPath: string,
  ) {}

  /** The token to use, or undefined when there is none. */
  read(): string | undefined {
    if (this.config.token) return this.config.token;
    return this.readFile()?.token;
  }

  source(): TokenSource {
    if (this.config.token) return 'environment';
    return this.readFile() ? 'file' : 'none';
  }

  /** When the stored token was written, for status output. Never the token itself. */
  savedAt(): string | undefined {
    return this.readFile()?.savedAt;
  }

  private readFile(): StoredToken | undefined {
    if (!existsSync(this.tokenPath)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(this.tokenPath, 'utf8')) as Partial<StoredToken>;
      if (typeof parsed.token !== 'string' || parsed.token.trim() === '') return undefined;
      return {
        token: parsed.token.trim(),
        savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : 'unknown',
      };
    } catch (error) {
      this.logger.warn(
        `${this.tokenPath} could not be read as a stored token: ` +
          `${error instanceof Error ? error.message : String(error)}. Run \`omocop-swarm auth\` again.`,
      );
      return undefined;
    }
  }

  /**
   * Saves a token.
   *
   * Written to a temp file and renamed so a crash cannot leave a truncated
   * credential behind, and chmod'ed to owner-only, which is a no-op on Windows
   * and the whole protection on everything else, so it is attempted rather than
   * required.
   *
   * It creates its own directory rather than assuming a caller did. Two entry
   * points reach a sign-in (the `auth` bin and `omocop-swarm auth`), only one of
   * them used to prepare the archive, and the resulting ENOENT surfaced in the
   * browser as "failed to fetch" with nothing in the log. A writer that makes
   * what it needs cannot be reached in that state.
   */
  write(token: string): void {
    mkdirSync(dirname(this.tokenPath), { recursive: true });
    const payload: StoredToken = { token, savedAt: new Date().toISOString() };
    const temp = `${this.tokenPath}.tmp`;
    writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      chmodSync(temp, 0o600);
    } catch {
      // Windows has no equivalent; the rename still has to happen.
    }
    renameSync(temp, this.tokenPath);
    this.logger.info(`Token saved to ${this.tokenPath}.`);
  }

  /** Removes the stored token. The environment variable, if set, is untouched. */
  forget(): boolean {
    if (!existsSync(this.tokenPath)) return false;
    unlinkSync(this.tokenPath);
    this.logger.info(`Removed ${this.tokenPath}.`);
    return true;
  }
}
