/**
 * Unicode display width utilities for terminal rendering.
 * Determines how many terminal columns a character occupies.
 */

import { EMOJI_PRESENTATION_RANGES, TEXT_PRESENTATION_EMOJI_RANGES } from './emoji-data.gen.js';

/** Binary search through sorted [start, end] inclusive ranges. */
function inRanges(cp: number, ranges: [number, number][]): boolean {
  let lo = 0, hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [start, end] = ranges[mid]!;
    if (cp < start) hi = mid - 1;
    else if (cp > end) lo = mid + 1;
    else return true;
  }
  return false;
}

/**
 * Return the display width of a single Unicode code point.
 * Returns 2 for fullwidth/wide characters (CJK, emoji, etc).
 * Returns 0 for zero-width characters (combining marks, ZWJ, etc).
 * Returns 1 for everything else.
 */
export function charDisplayWidth(codePoint: number): number {
  // Zero-width characters
  if (isZeroWidth(codePoint)) return 0;
  // Terminal-specific overrides: Japanese button emoji that terminals render as width 2
  // despite not having Emoji_Presentation=Yes in Unicode data
  if (codePoint === 0x1f202 || codePoint === 0x1f237) return 2;
  // Wide / fullwidth characters
  if (isWide(codePoint)) return 2;
  return 1;
}

/**
 * Returns true if the code point is a text-presentation emoji
 * (Emoji=Yes but Emoji_Presentation=No). These are width 1 by default
 * but become width 2 when followed by U+FE0F (VS16).
 */
export function isTextPresentationEmoji(codePoint: number): boolean {
  return inRanges(codePoint, TEXT_PRESENTATION_EMOJI_RANGES);
}

function isZeroWidth(cp: number): boolean {
  // Combining Diacritical Marks
  if (cp >= 0x0300 && cp <= 0x036f) return true;
  // Combining Cyrillic
  if (cp >= 0x0483 && cp <= 0x0489) return true;
  // Hebrew combining
  if (cp >= 0x0591 && cp <= 0x05bd) return true;
  // Arabic combining
  if (cp >= 0x0610 && cp <= 0x061a) return true;
  if (cp >= 0x064b && cp <= 0x065f) return true;
  if (cp === 0x0670) return true;
  if (cp >= 0x06d6 && cp <= 0x06dc) return true;
  if (cp >= 0x06df && cp <= 0x06e4) return true;
  if (cp >= 0x06e7 && cp <= 0x06e8) return true;
  if (cp >= 0x06ea && cp <= 0x06ed) return true;
  // Syriac combining
  if (cp === 0x0711) return true;
  if (cp >= 0x0730 && cp <= 0x074a) return true;
  // Zero-width space, ZWNJ, ZWJ, direction marks
  if (cp >= 0x200b && cp <= 0x200f) return true;
  // Line/paragraph separators, direction overrides
  if (cp >= 0x2028 && cp <= 0x202e) return true;
  // Word joiner, invisible operators
  if (cp >= 0x2060 && cp <= 0x2064) return true;
  // Combining Marks for Symbols
  if (cp >= 0x20d0 && cp <= 0x20ff) return true;
  // Variation Selectors
  if (cp >= 0xfe00 && cp <= 0xfe0f) return true;
  // Combining Half Marks
  if (cp >= 0xfe20 && cp <= 0xfe2f) return true;
  // BOM / zero-width no-break space
  if (cp === 0xfeff) return true;
  // Variation Selectors Supplement
  if (cp >= 0xe0100 && cp <= 0xe01ef) return true;
  // Tag characters (used in flag subdivision sequences like 🏴󠁧󠁢󠁥󠁮󠁧󠁿)
  if (cp >= 0xe0020 && cp <= 0xe007f) return true;

  return false;
}

function isWide(cp: number): boolean {
  // Hangul Jamo
  if (cp >= 0x1100 && cp <= 0x115f) return true;
  // CJK Radicals, Kangxi, CJK Symbols
  if (cp >= 0x2e80 && cp <= 0x303e) return true;
  // Hiragana, Katakana, Bopomofo, Kanbun, CJK Compat
  if (cp >= 0x3040 && cp <= 0x33bf) return true;
  // CJK Extension A
  if (cp >= 0x3400 && cp <= 0x4dbf) return true;
  // CJK Unified Ideographs
  if (cp >= 0x4e00 && cp <= 0x9fff) return true;
  // Yi
  if (cp >= 0xa000 && cp <= 0xa4cf) return true;
  // Hangul Syllables
  if (cp >= 0xac00 && cp <= 0xd7af) return true;
  // CJK Compat Ideographs
  if (cp >= 0xf900 && cp <= 0xfaff) return true;
  // CJK Compat Forms, Small Forms
  if (cp >= 0xfe10 && cp <= 0xfe6f) return true;
  // Fullwidth Forms
  if (cp >= 0xff01 && cp <= 0xff60) return true;
  // Fullwidth Signs
  if (cp >= 0xffe0 && cp <= 0xffe6) return true;
  // Emoji with default emoji presentation (always width 2)
  if (inRanges(cp, EMOJI_PRESENTATION_RANGES)) return true;
  // CJK Extension B and beyond
  if (cp >= 0x20000 && cp <= 0x2ffff) return true;
  // CJK Extension G+
  if (cp >= 0x30000 && cp <= 0x3ffff) return true;

  return false;
}

/**
 * Return the total display width of a string in terminal columns.
 * Iterates by code point (handles surrogate pairs correctly).
 * Accounts for VS16 (U+FE0F) upgrading text-presentation emoji to width 2.
 */
export function stringDisplayWidth(str: string): number {
  let width = 0;
  let prevCp = -1;
  for (const ch of str) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0xfe0f && prevCp >= 0 && isTextPresentationEmoji(prevCp) && charDisplayWidth(prevCp) === 1) {
      // VS16 after a text-presentation emoji that is width 1: upgrade to width 2
      width += 1;
      prevCp = cp;
      continue;
    }
    width += charDisplayWidth(cp);
    prevCp = cp;
  }
  return width;
}

/**
 * Slice text from the start to fit within maxCols display columns.
 * Returns a substring whose display width is <= maxCols.
 * Never splits a surrogate pair or a wide character.
 */
export function sliceToWidth(text: string, maxCols: number): string {
  let cols = 0;
  let strIdx = 0;
  for (const ch of text) {
    const w = charDisplayWidth(ch.codePointAt(0)!);
    if (cols + w > maxCols) break;
    cols += w;
    strIdx += ch.length;
  }
  return text.slice(0, strIdx);
}

/**
 * Slice text from the end to fit within maxCols display columns.
 * Returns a substring whose display width is <= maxCols.
 * Never splits a surrogate pair or a wide character.
 */
export function sliceFromEndToWidth(text: string, maxCols: number): string {
  const codePoints = [...text];
  let cols = 0;
  let count = 0;
  for (let i = codePoints.length - 1; i >= 0; i--) {
    const w = charDisplayWidth(codePoints[i]!.codePointAt(0)!);
    if (cols + w > maxCols) break;
    cols += w;
    count++;
  }
  // Reconstruct from the last `count` code points
  const startIdx = codePoints.length - count;
  return codePoints.slice(startIdx).join('');
}
