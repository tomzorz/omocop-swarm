/**
 * Properties every tool must hold, checked against the whole surface at once.
 *
 * These are the invariants that break quietly. A tool added without an output
 * schema fails at the client with a protocol error; a description written for a
 * human rather than a model makes the tool unpickable; a tool that reaches the
 * network without declaring it defeats the requirement gate. None of these show
 * up in a test of the tool itself.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TokenStore } from '../../src/auth/token-store.js';
import { loadConfig } from '../../src/config.js';
import { createLogger } from '../../src/logging.js';
import { HIDDEN_TOOLS } from '../../src/cli/help.js';
import { flagSpecs } from '../../src/cli/flags.js';
import { allTools, toolGroups } from '../../src/tools/all.js';

const config = loadConfig({});
const store = new TokenStore(config, createLogger('error', () => undefined), 'nowhere.json');
const tools = allTools(store);

describe('the tool surface', () => {
  it('has tools in it', () => {
    expect(tools.length).toBeGreaterThan(10);
  });

  it('names every tool uniquely', () => {
    const names = tools.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('names every tool in lower kebab case', () => {
    for (const tool of tools) expect(tool.name, tool.name).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it('describes every tool well enough for a model to pick it', () => {
    for (const tool of tools) {
      expect(tool.description.length, tool.name).toBeGreaterThan(80);
      expect(tool.description.trim().endsWith('.'), tool.name).toBe(true);
    }
  });

  it('declares both schemas on every tool', () => {
    for (const tool of tools) {
      expect(tool.input, tool.name).toBeDefined();
      expect(Object.keys(tool.output).length, tool.name).toBeGreaterThan(0);
    }
  });

  it('gives every tool a renderer', () => {
    for (const tool of tools) expect(typeof tool.render, tool.name).toBe('function');
  });

  it('declares a requirement on every tool', () => {
    for (const tool of tools) {
      expect(['archive', 'api'], tool.name).toContain(tool.requires);
    }
  });

  it('keeps `sync` the only tool that reaches Foursquare', () => {
    // Read-only was the decision. Anything else declaring 'api' means a tool
    // grew a network path, and that is a design change rather than a detail.
    // check-auth-status declares 'archive' because its one GET is opt-in
    // (verify, off by default) and it must still answer with no token; the
    // queries suite pins that it stays offline unless asked.
    expect(tools.filter((tool) => tool.requires === 'api').map((tool) => tool.name)).toEqual([
      'sync',
    ]);
  });

  it('marks every query tool read-only for the client to see', () => {
    for (const tool of tools) {
      if (tool.name === 'sync' || tool.name === 'reindex') continue;
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
    }
  });

  it('never claims a destructive tool exists, because none does', () => {
    for (const tool of tools) expect(tool.annotations?.destructiveHint ?? false, tool.name).toBe(false);
  });

  it('describes every input field, so --help is usable', () => {
    for (const tool of tools) {
      for (const spec of flagSpecs(tool.input)) {
        expect(spec.description, `${tool.name} --${spec.flag}`).toBeTruthy();
      }
    }
  });

  it('produces a valid zod object from every output shape', () => {
    for (const tool of tools) {
      expect(() => z.object(tool.output), tool.name).not.toThrow();
    }
  });

  it('groups every tool exactly once', () => {
    const grouped = toolGroups(store).flatMap((group) => group.tools.map((tool) => tool.name));
    expect(grouped.sort()).toEqual(tools.map((tool) => tool.name).sort());
  });

  it('hides only tools that exist', () => {
    for (const hidden of HIDDEN_TOOLS) {
      expect(tools.some((tool) => tool.name === hidden), hidden).toBe(true);
    }
  });
});
