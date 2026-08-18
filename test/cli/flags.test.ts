import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { flagSpecs, kebabCase, parseFlags, validateInput } from '../../src/cli/flags.js';

const shape = {
  from: z.string().optional().describe('First day.'),
  dayStart: z.number().int().min(0).max(23).optional(),
  withPhotos: z.boolean().optional(),
  sort: z.enum(['newest', 'oldest']).default('newest'),
  limit: z.number().int().default(50),
  tags: z.array(z.string()).optional(),
  scores: z.array(z.number()).optional(),
  id: z.string().min(1),
};

describe('flagSpecs', () => {
  it('derives a kebab-case flag per field', () => {
    expect(flagSpecs(shape).map((spec) => spec.flag)).toEqual([
      'from',
      'day-start',
      'with-photos',
      'sort',
      'limit',
      'tags',
      'scores',
      'id',
    ]);
  });

  it('classifies the kinds', () => {
    const byField = new Map(flagSpecs(shape).map((spec) => [spec.field, spec]));
    expect(byField.get('withPhotos')?.kind).toBe('boolean');
    expect(byField.get('limit')?.kind).toBe('number');
    expect(byField.get('tags')?.kind).toBe('array');
    expect(byField.get('scores')?.element).toBe('number');
    expect(byField.get('sort')?.choices).toEqual(['newest', 'oldest']);
  });

  it('treats a defaulted field as optional', () => {
    const byField = new Map(flagSpecs(shape).map((spec) => [spec.field, spec]));
    expect(byField.get('limit')?.required).toBe(false);
    expect(byField.get('id')?.required).toBe(true);
  });

  it('finds a description written before .optional()', () => {
    const byField = new Map(flagSpecs(shape).map((spec) => [spec.field, spec]));
    expect(byField.get('from')?.description).toBe('First day.');
  });
});

describe('parseFlags', () => {
  const specs = flagSpecs(shape);
  const parse = (...argv: string[]) => parseFlags(specs, argv);

  it('reads a value from the next token or from an inline =', () => {
    expect(parse('--from', '2019-06-12')).toMatchObject({ input: { from: '2019-06-12' } });
    expect(parse('--from=2019-06-12')).toMatchObject({ input: { from: '2019-06-12' } });
  });

  it('coerces a numeric flag', () => {
    expect(parse('--limit', '10')).toMatchObject({ input: { limit: 10 } });
  });

  it('treats a bare boolean as true and honours an explicit false', () => {
    expect(parse('--with-photos')).toMatchObject({ input: { withPhotos: true } });
    expect(parse('--with-photos=false')).toMatchObject({ input: { withPhotos: false } });
  });

  it('never lets a boolean swallow the following token', () => {
    const parsed = parse('--with-photos', '--from', '2019-06-12');
    expect(parsed).toMatchObject({ input: { withPhotos: true, from: '2019-06-12' } });
  });

  it('accumulates repeated array flags without splitting on commas', () => {
    expect(parse('--tags', 'a,b', '--tags', 'c')).toMatchObject({ input: { tags: ['a,b', 'c'] } });
  });

  it('rejects a scalar flag given twice rather than silently taking the last', () => {
    const parsed = parse('--from', 'a', '--from', 'b');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors[0]).toMatch(/more than once/);
  });

  it('rejects an unknown flag and does not then complain about its value', () => {
    const parsed = parse('--nope', 'value');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toHaveLength(1);
      expect(parsed.errors[0]).toMatch(/Unknown flag --nope/);
    }
  });

  it('rejects a bare argument', () => {
    const parsed = parse('2019-06-12');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors[0]).toMatch(/Unexpected argument/);
  });

  it('rejects a flag with no value at the end of the line', () => {
    const parsed = parse('--from');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors[0]).toMatch(/requires a value/);
  });

  it('defaults to text and takes --format or --json', () => {
    expect(parse()).toMatchObject({ format: 'text' });
    expect(parse('--format', 'json')).toMatchObject({ format: 'json' });
    expect(parse('--json')).toMatchObject({ format: 'json' });
  });

  it('rejects an unknown format', () => {
    const parsed = parse('--format', 'yaml');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors[0]).toMatch(/--format must be one of/);
  });
});

describe('validateInput', () => {
  it('applies the tool\'s own schema, defaults included', () => {
    const result = validateInput(shape, { id: 'x' });
    expect(result).toMatchObject({ ok: true, args: { id: 'x', sort: 'newest', limit: 50 } });
  });

  it('reports a failure against the flag name, not the field name', () => {
    const result = validateInput(shape, { id: 'x', dayStart: 99 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/^--day-start:/);
  });

  it('reports a missing required field', () => {
    const result = validateInput(shape, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/^--id:/);
  });
});

describe('kebabCase', () => {
  it.each([
    ['from', 'from'],
    ['dayStart', 'day-start'],
    ['withPhotos', 'with-photos'],
    ['maxPages', 'max-pages'],
  ])('turns %s into %s', (field, expected) => {
    expect(kebabCase(field)).toBe(expected);
  });
});
