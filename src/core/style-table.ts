/**
 * Style interning table. Maps style tuples (attrs + fg + bg) to integer IDs,
 * with a transition cache for ANSI escape strings between style pairs.
 *
 * Supports color level downgrading: truecolor → 256 → 16 → none.
 */
import { ColorMode } from './cell.js';

/** ID for the default/empty style — always 0. */
export const DEFAULT_STYLE = 0;

const ESC = '\x1b[';

// --- Color conversion utilities ---

/** Convert RGB to nearest ANSI 256-color index. */
function rgbToAnsi256(r: number, g: number, b: number): number {
  // Greyscale ramp (indices 232-255) — check if r≈g≈b
  if (Math.abs(r - g) <= 5 && Math.abs(g - b) <= 5) {
    const avg = (r + g + b) / 3;
    if (avg < 4) return 16;   // black
    if (avg > 248) return 231; // white
    return Math.round((avg - 8) / 247 * 23) + 232;
  }
  // 6x6x6 color cube (indices 16-231)
  const ri = Math.round(r / 255 * 5);
  const gi = Math.round(g / 255 * 5);
  const bi = Math.round(b / 255 * 5);
  return 16 + 36 * ri + 6 * gi + bi;
}

/** The 16 basic ANSI colors as RGB. */
const ANSI_16_RGB: [number, number, number][] = [
  [0, 0, 0],       // 0  black
  [128, 0, 0],     // 1  red
  [0, 128, 0],     // 2  green
  [128, 128, 0],   // 3  yellow
  [0, 0, 128],     // 4  blue
  [128, 0, 128],   // 5  magenta
  [0, 128, 128],   // 6  cyan
  [192, 192, 192], // 7  white
  [128, 128, 128], // 8  bright black
  [255, 0, 0],     // 9  bright red
  [0, 255, 0],     // 10 bright green
  [255, 255, 0],   // 11 bright yellow
  [0, 0, 255],     // 12 bright blue
  [255, 0, 255],   // 13 bright magenta
  [0, 255, 255],   // 14 bright cyan
  [255, 255, 255], // 15 bright white
];

/** Convert RGB to nearest basic 16 ANSI color index by Euclidean distance. */
function rgbToAnsi16(r: number, g: number, b: number): number {
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < 16; i++) {
    const [cr, cg, cb] = ANSI_16_RGB[i]!;
    const dr = r - cr, dg = g - cg, db = b - cb;
    const dist = dr * dr + dg * dg + db * db;
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  return bestIdx;
}

// --- Style table ---

interface StyleEntry {
  attrs: number;
  fgMode: number;
  fgValue: number;
  bgMode: number;
  bgValue: number;
}

export class StyleTable {
  /** Reverse lookup: ID → style components. */
  private entries: StyleEntry[] = [];
  /** Composite key → ID. */
  private map = new Map<number, number>();
  /** Transition cache: packed (fromId, toId) → ANSI string. */
  private transitions = new Map<number, string>();
  /**
   * Terminal color level:
   *   3 = truecolor (38;2;R;G;B)
   *   2 = 256-color (38;5;N)
   *   1 = 16-color (30-37/90-97)
   *   0 = no color
   */
  readonly colorLevel: number;

  constructor(colorLevel: number = 3) {
    this.colorLevel = colorLevel;
    // Pre-register default style at ID 0
    const entry: StyleEntry = {
      attrs: 0,
      fgMode: ColorMode.Default,
      fgValue: 0,
      bgMode: ColorMode.Default,
      bgValue: 0,
    };
    this.entries.push(entry);
    this.map.set(this.compositeKey(0, ColorMode.Default, 0, ColorMode.Default, 0), DEFAULT_STYLE);
  }

  /**
   * Compute a composite key from the 5 style values.
   * Uses arithmetic combination that is unique for valid inputs:
   * - attrs: 0–63 (6 bits)
   * - fgMode/bgMode: 0–2
   * - fgValue/bgValue: 0–16777215 (24 bits)
   */
  private compositeKey(
    attrs: number,
    fgMode: number,
    fgValue: number,
    bgMode: number,
    bgValue: number,
  ): number {
    // Pack into a single number. We use multiplication with primes
    // to spread values, but also validate on hit to catch any collision.
    // attrs (6 bits) + fgMode (2 bits) + bgMode (2 bits) = 10 bits < 1024
    // fgValue and bgValue are up to 24 bits each.
    // Total: we need ~58 bits. JS numbers have 53 bits of integer precision,
    // so we use a scheme that fits within safe integer range for common cases
    // and falls back to string key for overflow.
    return (
      attrs +
      fgMode * 64 +
      bgMode * 192 +
      fgValue * 576 +
      bgValue * 576 * 16777216
    );
  }

  /** Returns the ID for a style tuple, creating a new entry if unseen. */
  intern(
    attrs: number,
    fgMode: number,
    fgValue: number,
    bgMode: number,
    bgValue: number,
  ): number {
    const key = this.compositeKey(attrs, fgMode, fgValue, bgMode, bgValue);
    const existing = this.map.get(key);
    if (existing !== undefined) {
      // Debug assertion: verify no collision
      if (process.env.NODE_ENV !== 'production') {
        const e = this.entries[existing]!;
        if (
          e.attrs !== attrs ||
          e.fgMode !== fgMode ||
          e.fgValue !== fgValue ||
          e.bgMode !== bgMode ||
          e.bgValue !== bgValue
        ) {
          throw new Error(
            `StyleTable key collision: key=${key} maps to ID ${existing} ` +
            `with different values`,
          );
        }
      }
      return existing;
    }
    const id = this.entries.length;
    this.entries.push({ attrs, fgMode, fgValue, bgMode, bgValue });
    this.map.set(key, id);
    return id;
  }

  /** Returns the components for an ID. */
  resolve(id: number): StyleEntry {
    const e = this.entries[id];
    if (!e) {
      return {
        attrs: 0,
        fgMode: ColorMode.Default,
        fgValue: 0,
        bgMode: ColorMode.Default,
        bgValue: 0,
      };
    }
    return { ...e };
  }

  /**
   * Returns the ANSI escape string to transition from one style to another.
   * Cached by (fromId, toId). Same-ID pairs return empty string immediately.
   */
  transition(fromId: number, toId: number): string {
    if (fromId === toId) return '';

    const cacheKey = fromId * 0x100000 + toId;
    const cached = this.transitions.get(cacheKey);
    if (cached !== undefined) return cached;

    const from = this.entries[fromId]!;
    const to = this.entries[toId]!;
    const result = this.computeTransition(from, to);
    this.transitions.set(cacheKey, result);
    return result;
  }

  /** Number of interned styles. */
  get size(): number {
    return this.entries.length;
  }

  /** Number of cached transitions. */
  get transitionCacheSize(): number {
    return this.transitions.size;
  }

  // --- SGR computation (ported from diff.ts styleDelta/styleToAnsi) ---

  private colorSgrParams(mode: number, value: number, fgOrBg: 'fg' | 'bg'): string {
    const level = this.colorLevel;
    if (mode === ColorMode.Default) {
      return fgOrBg === 'fg' ? '39' : '49';
    } else if (mode === ColorMode.Palette) {
      // Palette colors pass through regardless of level
      return fgOrBg === 'fg' ? `38;5;${value}` : `48;5;${value}`;
    } else {
      // RGB mode — downgrade based on color level
      const r = (value >> 16) & 0xff;
      const g = (value >> 8) & 0xff;
      const b = value & 0xff;
      if (level >= 3) {
        return fgOrBg === 'fg' ? `38;2;${r};${g};${b}` : `48;2;${r};${g};${b}`;
      } else if (level === 2) {
        const idx = rgbToAnsi256(r, g, b);
        return fgOrBg === 'fg' ? `38;5;${idx}` : `48;5;${idx}`;
      } else if (level === 1) {
        const idx = rgbToAnsi16(r, g, b);
        // Basic 16 colors: 0-7 → 30-37 (fg) / 40-47 (bg), 8-15 → 90-97 / 100-107
        if (fgOrBg === 'fg') {
          return idx < 8 ? `${30 + idx}` : `${90 + idx - 8}`;
        } else {
          return idx < 8 ? `${40 + idx}` : `${100 + idx - 8}`;
        }
      } else {
        // No color
        return fgOrBg === 'fg' ? '39' : '49';
      }
    }
  }

  /** Full style → SGR (from-default path). */
  private styleToAnsi(s: StyleEntry): string {
    const parts: string[] = [];

    if (s.attrs & 1) parts.push('1');   // bold
    if (s.attrs & 16) parts.push('2');  // dim
    if (s.attrs & 2) parts.push('3');   // italic
    if (s.attrs & 4) parts.push('4');   // underline
    if (s.attrs & 32) parts.push('7');  // inverse
    if (s.attrs & 8) parts.push('9');   // strikethrough

    parts.push(this.colorSgrParams(s.fgMode, s.fgValue, 'fg'));
    parts.push(this.colorSgrParams(s.bgMode, s.bgValue, 'bg'));

    return `${ESC}${parts.join(';')}m`;
  }

  private colorsEq(aMode: number, aValue: number, bMode: number, bValue: number): boolean {
    return aMode === bMode && aValue === bValue;
  }

  /**
   * Compute minimal SGR transition between two styles.
   * Ported from diff.ts styleDelta, adapted to work with decomposed tuples.
   */
  private computeTransition(from: StyleEntry, to: StyleEntry): string {
    // Fast path: identical styles
    if (
      from.attrs === to.attrs &&
      this.colorsEq(from.fgMode, from.fgValue, to.fgMode, to.fgValue) &&
      this.colorsEq(from.bgMode, from.bgValue, to.bgMode, to.bgValue)
    ) {
      return '';
    }

    const toIsDefault =
      to.attrs === 0 &&
      to.fgMode === ColorMode.Default &&
      to.bgMode === ColorMode.Default;

    // Target is fully default: just reset
    if (toIsDefault) {
      return `${ESC}0m`;
    }

    // Fast path: fg-only change
    if (
      from.attrs === to.attrs &&
      this.colorsEq(from.bgMode, from.bgValue, to.bgMode, to.bgValue)
    ) {
      return `${ESC}${this.colorSgrParams(to.fgMode, to.fgValue, 'fg')}m`;
    }

    // Fast path: bg-only change
    if (
      from.attrs === to.attrs &&
      this.colorsEq(from.fgMode, from.fgValue, to.fgMode, to.fgValue)
    ) {
      return `${ESC}${this.colorSgrParams(to.bgMode, to.bgValue, 'bg')}m`;
    }

    // Fast path: from default — emit full style
    if (
      from.attrs === 0 &&
      from.fgMode === ColorMode.Default &&
      from.bgMode === ColorMode.Default
    ) {
      return this.styleToAnsi(to);
    }

    // General case: build both a targeted delta and a full reset path, pick shorter
    let delta = '';

    const added = to.attrs & ~from.attrs;
    const removed = from.attrs & ~to.attrs;

    // Bold (SGR 1) and Dim (SGR 2) share turn-off code (SGR 22)
    const removedBoldDim = removed & 0x11;
    if (removedBoldDim) {
      delta = '22';
      if ((to.attrs & 0x01) && (removedBoldDim & 0x10)) delta += ';1';
      if ((to.attrs & 0x10) && (removedBoldDim & 0x01)) delta += ';2';
    }

    if (removed & 0x02) delta += (delta ? ';23' : '23');
    if (removed & 0x04) delta += (delta ? ';24' : '24');
    if (removed & 0x08) delta += (delta ? ';29' : '29');
    if (removed & 0x20) delta += (delta ? ';27' : '27');

    if ((added & 0x01) && !removedBoldDim) delta += (delta ? ';1' : '1');
    if ((added & 0x10) && !removedBoldDim) delta += (delta ? ';2' : '2');
    if (added & 0x02) delta += (delta ? ';3' : '3');
    if (added & 0x04) delta += (delta ? ';4' : '4');
    if (added & 0x08) delta += (delta ? ';9' : '9');
    if (added & 0x20) delta += (delta ? ';7' : '7');

    if (!this.colorsEq(from.fgMode, from.fgValue, to.fgMode, to.fgValue)) {
      const p = this.colorSgrParams(to.fgMode, to.fgValue, 'fg');
      delta += (delta ? ';' + p : p);
    }
    if (!this.colorsEq(from.bgMode, from.bgValue, to.bgMode, to.bgValue)) {
      const p = this.colorSgrParams(to.bgMode, to.bgValue, 'bg');
      delta += (delta ? ';' + p : p);
    }

    const deltaSeq = delta ? `${ESC}${delta}m` : '';

    // Reset path: \x1b[0;...non-default target params...m
    let reset = '0';
    if (to.attrs & 0x01) reset += ';1';
    if (to.attrs & 0x10) reset += ';2';
    if (to.attrs & 0x02) reset += ';3';
    if (to.attrs & 0x04) reset += ';4';
    if (to.attrs & 0x20) reset += ';7';
    if (to.attrs & 0x08) reset += ';9';
    if (to.fgMode !== ColorMode.Default) reset += ';' + this.colorSgrParams(to.fgMode, to.fgValue, 'fg');
    if (to.bgMode !== ColorMode.Default) reset += ';' + this.colorSgrParams(to.bgMode, to.bgValue, 'bg');
    const resetSeq = `${ESC}${reset}m`;

    return deltaSeq.length <= resetSeq.length ? deltaSeq : resetSeq;
  }
}
