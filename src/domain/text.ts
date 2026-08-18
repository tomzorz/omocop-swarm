/**
 * Folding text so that searching for it works the way a person types.
 *
 * SQLite's `LIKE` is case-insensitive for ASCII and nothing else. In an archive
 * of a Hungarian life that is not a detail: `kulturalis` finds nothing,
 * `Kulturális` finds 149, and the difference is two keystrokes nobody wants to
 * think about on a phone keyboard. `CAFÉ` and `café` are likewise different
 * strings to it.
 *
 * So every searchable column is stored a second time, folded, and the query is
 * folded to match. Folding is:
 *
 *   1. NFD, which splits `ü` into `u` followed by a combining diaeresis
 *   2. drop the combining marks
 *   3. lowercase
 *
 * The result is that `kulturalis`, `Kulturális` and `KULTURÁLIS` are one term.
 * Accents are dropped rather than preserved because the direction people need
 * is typing less, not more: somebody searching `Kulturális` still wants the
 * match, and somebody searching `kulturalis` cannot get one any other way.
 *
 * This throws away real distinctions in some languages — folded, Swedish `å`
 * and `a` are the same letter, and they are not. That is the accepted cost; the
 * alternative is a full collation library for a search box over one person's
 * check-ins.
 */

/**
 * Case-folded, accent-stripped form of a string, for matching only.
 *
 * Never store this as the displayed value. It exists beside the original, which
 * stays exactly as the API sent it.
 */
export function fold(text: string): string {
  return text
    .normalize('NFD')
    // Unicode combining marks: everything NFD split off in step 1.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/** Folds a value for storage, passing through absence unchanged. */
export const foldOrNull = (text: string | undefined | null): string | null =>
  text === undefined || text === null || text === '' ? null : fold(text);
