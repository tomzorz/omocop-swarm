import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { API_VERSION, ConfigError, loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('works with nothing set at all, because the archive is readable without a token', () => {
    const config = loadConfig({});
    expect(config.token).toBeUndefined();
    expect(config.dataDir).toContain(homedir());
  });

  it('pins the API version rather than deriving it from today', () => {
    expect(API_VERSION).toMatch(/^\d{8}$/);
    expect(loadConfig({}).apiVersion).toBe(API_VERSION);
    expect(API_VERSION).not.toBe(new Date().toISOString().slice(0, 10).replace(/-/g, ''));
  });

  it('reads the token and treats whitespace as absent', () => {
    expect(loadConfig({ FOURSQUARE_TOKEN: ' abc ' }).token).toBe('abc');
    expect(loadConfig({ FOURSQUARE_TOKEN: '   ' }).token).toBeUndefined();
    expect(loadConfig({ FOURSQUARE_TOKEN: '' }).token).toBeUndefined();
  });

  it('derives the redirect URI from the port, so the two cannot disagree', () => {
    const config = loadConfig({ SWARM_AUTH_PORT: '4000' });
    expect(config.authPort).toBe(4000);
    expect(config.redirectUri).toBe('http://localhost:4000/callback');
  });

  it.each(['0', '70000', 'not-a-port'])('rejects the port %s', (port) => {
    expect(() => loadConfig({ SWARM_AUTH_PORT: port })).toThrow(ConfigError);
  });

  it('defaults the day start to midnight and accepts an override', () => {
    expect(loadConfig({}).dayStartHour).toBe(0);
    expect(loadConfig({ SWARM_DAY_START_HOUR: '6' }).dayStartHour).toBe(6);
  });

  it.each(['24', '-1', 'six'])('rejects the day start %s', (hour) => {
    expect(() => loadConfig({ SWARM_DAY_START_HOUR: hour })).toThrow(ConfigError);
  });

  it('defaults the page size to the documented maximum and refuses to exceed it', () => {
    expect(loadConfig({}).pageSize).toBe(250);
    expect(loadConfig({ SWARM_PAGE_SIZE: '50' }).pageSize).toBe(50);
    expect(() => loadConfig({ SWARM_PAGE_SIZE: '500' })).toThrow(/documented maximum/);
  });

  it('honours an overridden data directory', () => {
    expect(loadConfig({ SWARM_DATA_DIR: '/tmp/elsewhere' }).dataDir).toBe('/tmp/elsewhere');
  });

  it('names the setting in every error, so the message says what to fix', () => {
    expect(() => loadConfig({ SWARM_AUTH_PORT: 'x' })).toThrow(/SWARM_AUTH_PORT/);
    expect(() => loadConfig({ SWARM_PAGE_SIZE: '0' })).toThrow(/SWARM_PAGE_SIZE/);
  });
});
