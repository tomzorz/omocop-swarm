import { describe, expect, it } from 'vitest';
import { fold, foldOrNull } from '../../src/domain/text.js';

describe('fold', () => {
  it('collapses case and accents onto one form', () => {
    // The whole point: these are three ways of typing the same venue, and
    // SQLite's LIKE treats them as three different strings.
    expect(fold('Kulturális')).toBe('kulturalis');
    expect(fold('KULTURÁLIS')).toBe('kulturalis');
    expect(fold('kulturalis')).toBe('kulturalis');
  });

  it.each([
    ['Café', 'cafe'],
    ['Zürich', 'zurich'],
    ['Örs vezér tere', 'ors vezer tere'],
    ['Malmö', 'malmo'],
    ['Liszt Ferenc nemzetközi repülőtér', 'liszt ferenc nemzetkozi repuloter'],
    ['SANTA CRUZ DE TENERIFE', 'santa cruz de tenerife'],
  ])('folds %s to %s', (input, expected) => {
    expect(fold(input)).toBe(expected);
  });

  it('is idempotent', () => {
    for (const input of ['Kulturális', 'Café', 'plain']) {
      expect(fold(fold(input))).toBe(fold(input));
    }
  });

  it('leaves plain ASCII untouched apart from case', () => {
    expect(fold('Bubble Tea Shop')).toBe('bubble tea shop');
  });

  it('keeps non-letter characters, which are part of the name', () => {
    expect(fold("O'Brien's (BUD) #2")).toBe("o'brien's (bud) #2");
  });

  it('handles an already-decomposed string the same as a composed one', () => {
    // NFC "ü" and NFD "u + combining diaeresis" are different byte sequences
    // for the same character, and both turn up in real API data.
    expect(fold('ü')).toBe(fold('ü'));
  });

  it('does not collapse scripts it cannot decompose', () => {
    expect(fold('東京')).toBe('東京');
    expect(fold('Ελλάδα')).toBe('ελλαδα');
  });

  it('is empty for empty input', () => {
    expect(fold('')).toBe('');
  });
});

describe('foldOrNull', () => {
  it('passes absence through rather than folding it into an empty string', () => {
    expect(foldOrNull(undefined)).toBeNull();
    expect(foldOrNull(null)).toBeNull();
    expect(foldOrNull('')).toBeNull();
    expect(foldOrNull('Café')).toBe('cafe');
  });
});
