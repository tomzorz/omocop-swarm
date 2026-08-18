import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createLogger,
  installStdoutGuard,
  redact,
  STDOUT_CONSOLE_METHODS,
} from '../src/logging.js';

describe('redact', () => {
  it.each([
    ['https://api.foursquare.com/v2/x?oauth_token=SECRETVALUE&v=1', 'SECRETVALUE'],
    ['#access_token=SECRETVALUE&state=abc', 'SECRETVALUE'],
    ['Authorization: Bearer SECRETVALUEwithenoughlength123', 'SECRETVALUEwithenoughlength123'],
    ['{"access_token":"SECRETVALUE"}', 'SECRETVALUE'],
    ['FOURSQUARE_TOKEN=SECRETVALUE', 'SECRETVALUE'],
    ['client_secret: SECRETVALUE', 'SECRETVALUE'],
  ])('removes the credential from %s', (line, secret) => {
    const cleaned = redact(line);
    expect(cleaned).not.toContain(secret);
    expect(cleaned).toContain('redacted');
  });

  it('leaves ordinary text alone', () => {
    const line = 'Fetched 250 check-ins at offset 500 in 1.2s';
    expect(redact(line)).toBe(line);
  });

  it('keeps the non-secret parts of a URL readable', () => {
    const cleaned = redact('https://api.foursquare.com/v2/users/self/checkins?limit=250&oauth_token=X&v=20250401');
    expect(cleaned).toContain('limit=250');
    expect(cleaned).toContain('v=20250401');
  });
});

describe('createLogger', () => {
  it('writes at or below the configured level and nothing above it', () => {
    const lines: string[] = [];
    const logger = createLogger('warn', (chunk) => lines.push(chunk));

    logger.error('an error');
    logger.warn('a warning');
    logger.info('information');
    logger.debug('detail');

    expect(lines.join('')).toContain('an error');
    expect(lines.join('')).toContain('a warning');
    expect(lines.join('')).not.toContain('information');
    expect(lines.join('')).not.toContain('detail');
  });

  it('redacts at the sink, so no caller can leak by forgetting', () => {
    const lines: string[] = [];
    createLogger('debug', (chunk) => lines.push(chunk)).info('token is oauth_token=SUPERSECRET');
    expect(lines.join('')).not.toContain('SUPERSECRET');
  });

  it('renders an Error with its stack', () => {
    const lines: string[] = [];
    createLogger('error', (chunk) => lines.push(chunk)).error('failed', new Error('boom'));
    expect(lines.join('')).toContain('boom');
  });

  it('survives a value that cannot be serialised', () => {
    const lines: string[] = [];
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(() => createLogger('debug', (chunk) => lines.push(chunk)).debug(circular)).not.toThrow();
  });

  it('tags every line so its output is findable in a mixed stream', () => {
    const lines: string[] = [];
    createLogger('info', (chunk) => lines.push(chunk)).info('hello');
    expect(lines[0]).toMatch(/^\[omocop-swarm\] info: hello\n$/);
  });
});

describe('installStdoutGuard', () => {
  let restore: (() => void) | undefined;

  afterEach(() => {
    restore?.();
    restore = undefined;
    vi.restoreAllMocks();
  });

  it('redirects every stdout-writing console method away from stdout', () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const lines: string[] = [];

    restore = installStdoutGuard(createLogger('debug', (chunk) => lines.push(chunk)));

    for (const method of STDOUT_CONSOLE_METHODS) {
      (console as unknown as Record<string, (...parts: unknown[]) => void>)[method]?.('noise');
    }

    expect(write).not.toHaveBeenCalled();
    expect(lines.length).toBeGreaterThan(0);
  });

  it('leaves console.error and console.warn alone, since they go to stderr', () => {
    const original = console.error;
    restore = installStdoutGuard(createLogger('error', () => undefined));
    expect(console.error).toBe(original);
  });

  it('puts the console back', () => {
    const original = console.log;
    installStdoutGuard(createLogger('error', () => undefined))();
    expect(console.log).toBe(original);
  });
});
