/**
 * Unicode display width: how many terminal columns a character occupies (0, 1, or 2).
 *
 * Uses get-east-asian-width for CJK/fullwidth detection and Intl.Segmenter +
 * emoji-regex for grapheme-cluster-aware string width measurement.
 */

import { eastAsianWidth } from 'get-east-asian-width';
import emojiRegex from 'emoji-regex';
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
  // Terminal-specific overrides: these Japanese button emoji (🈂 🈷) are rendered as
  // width 2 by most terminals despite having Emoji_Presentation=No in Unicode data.
  // Verified against iTerm2, Terminal.app, and kitty via test-terminal-widths.ts.
  if (codePoint === 0x1f202 || codePoint === 0x1f237) return 2;
  // Emoji with default emoji presentation are always width 2 in terminals
  if (inRanges(codePoint, EMOJI_PRESENTATION_RANGES)) return 2;
  // Use get-east-asian-width for wide/fullwidth detection (ambiguous = narrow)
  return eastAsianWidth(codePoint, { ambiguousAsWide: false });
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

/**
 * Returns true if a codepoint is a skin tone modifier (Fitzpatrick scale).
 * U+1F3FB through U+1F3FF.
 */
export function isSkinToneModifier(cp: number): boolean {
  return cp >= 0x1f3fb && cp <= 0x1f3ff;
}

/**
 * Returns true if a codepoint is a Regional Indicator Symbol.
 * U+1F1E6 through U+1F1FF. Pairs of these form flag emoji.
 */
export function isRegionalIndicator(cp: number): boolean {
  return cp >= 0x1f1e6 && cp <= 0x1f1ff;
}

// --- Intl.Segmenter singleton ---

let segmenter: Intl.Segmenter | null = null;
function getSegmenter(): Intl.Segmenter {
  if (!segmenter) segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return segmenter;
}

// --- Emoji / complex sequence detection ---

/**
 * Returns true if the string contains codepoints that may form multi-codepoint
 * grapheme clusters (emoji ranges, variation selectors, ZWJ).
 */
function needsSegmentation(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    // ZWJ (U+200D)
    if (code === 0x200d) return true;
    // Variation selectors (U+FE00-U+FE0F)
    if (code >= 0xfe00 && code <= 0xfe0f) return true;
    // High surrogates for emoji ranges (U+D800-U+DBFF paired with low surrogates)
    // Most emoji are in U+1F000+ which uses surrogate pairs starting with 0xD83C-0xD83E
    if (code >= 0xd83c && code <= 0xd83e) return true;
    // Skin tone modifiers, regional indicators also use surrogates in this range
  }
  return false;
}

// Keycap combining mark
const KEYCAP = 0x20e3;

/** Memoization cache for stringDisplayWidth. */
const WIDTH_MEMO_CAP = 8192;
const _widthMemo: Map<string, number> = new Map();

/** Clear the stringDisplayWidth memo cache. */
export function clearWidthMemo(): void {
  _widthMemo.clear();
}

/**
 * Return the total display width of a string in terminal columns.
 *
 * Fast path: if the string has no emoji/ZWJ/VS indicators, iterate codepoints
 * and sum widths using eastAsianWidth.
 *
 * Slow path: use Intl.Segmenter for grapheme clusters, then emoji-regex to
 * detect emoji clusters (width 2) vs. text clusters (first codepoint's width).
 */
export function stringDisplayWidth(str: string): number {
  if (str.length === 0) return 0;
  if (str.length >= 2) {
    const cached = _widthMemo.get(str);
    if (cached !== undefined) return cached;
  }

  let width: number;
  if (!needsSegmentation(str)) {
    // Fast path: simple codepoint iteration
    width = 0;
    for (const ch of str) {
      width += charDisplayWidth(ch.codePointAt(0)!);
    }
  } else {
    // Slow path: grapheme segmentation + emoji detection
    width = 0;
    const re = emojiRegex();
    const seg = getSegmenter();
    for (const { segment } of seg.segment(str)) {
      if (segment.length === 1) {
        width += charDisplayWidth(segment.codePointAt(0)!);
        continue;
      }
      // Multi-codepoint cluster: test if it's an emoji
      re.lastIndex = 0;
      const m = re.exec(segment);
      if (m && m[0] === segment) {
        // Full emoji cluster — check exceptions
        const firstCp = segment.codePointAt(0)!;
        // Incomplete keycap: digit + VS16 without U+20E3 — width 1
        if (segment.length <= 3 && segment.charCodeAt(segment.length - 1) !== KEYCAP &&
            firstCp >= 0x30 && firstCp <= 0x39) {
          width += 1;
          continue;
        }
        width += 2;
      } else {
        // Not an emoji cluster — use first non-zero-width codepoint's width
        for (const ch of segment) {
          const cp = ch.codePointAt(0)!;
          if (!isZeroWidth(cp)) {
            width += charDisplayWidth(cp);
            break;
          }
        }
      }
    }
  }

  if (str.length >= 2) {
    if (_widthMemo.size >= WIDTH_MEMO_CAP) _widthMemo.clear();
    _widthMemo.set(str, width);
  }
  return width;
}

/**
 * Slice text from the start to fit within maxCols display columns.
 * Returns a substring whose display width is <= maxCols.
 * Never splits a grapheme cluster.
 */
export function sliceToWidth(text: string, maxCols: number): string {
  if (!needsSegmentation(text)) {
    // Fast path: codepoint iteration
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

  // Slow path: grapheme segmentation
  const seg = getSegmenter();
  let cols = 0;
  let endIdx = 0;
  for (const { segment, index } of seg.segment(text)) {
    const w = stringDisplayWidth(segment);
    if (cols + w > maxCols) break;
    cols += w;
    endIdx = index + segment.length;
  }
  return text.slice(0, endIdx);
}

/**
 * Slice text from the end to fit within maxCols display columns.
 * Returns a substring whose display width is <= maxCols.
 * Never splits a grapheme cluster.
 */
export function sliceFromEndToWidth(text: string, maxCols: number): string {
  // Always use segmenter for reverse slicing — simpler and correct
  const seg = getSegmenter();
  const clusters: { segment: string; index: number }[] = [];
  for (const item of seg.segment(text)) {
    clusters.push(item);
  }

  let cols = 0;
  let startIdx = text.length;
  for (let i = clusters.length - 1; i >= 0; i--) {
    const c = clusters[i]!;
    const w = stringDisplayWidth(c.segment);
    if (cols + w > maxCols) break;
    cols += w;
    startIdx = c.index;
  }
  return text.slice(startIdx);
}
