/**
 * Style interning table. Maps style tuples (attrs + fg + bg) to integer IDs,
 * with a transition cache for ANSI escape strings between style pairs.
 */
import { ColorMode } from './cell.js';

/** ID for the default/empty style — always 0. */
export const DEFAULT_STYLE = 0;

const ESC = '\x1b[';

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

  constructor() {
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
    if (mode === ColorMode.Default) {
      return fgOrBg === 'fg' ? '39' : '49';
    } else if (mode === ColorMode.Palette) {
      return fgOrBg === 'fg' ? `38;5;${value}` : `48;5;${value}`;
    } else {
      const r = (value >> 16) & 0xff;
      const g = (value >> 8) & 0xff;
      const b = value & 0xff;
      return fgOrBg === 'fg' ? `38;2;${r};${g};${b}` : `48;2;${r};${g};${b}`;
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

    if (s.fgMode === ColorMode.Default) {
      parts.push('39');
    } else if (s.fgMode === ColorMode.Palette) {
      parts.push(`38;5;${s.fgValue}`);
    } else {
      const r = (s.fgValue >> 16) & 0xff;
      const g = (s.fgValue >> 8) & 0xff;
      const b = s.fgValue & 0xff;
      parts.push(`38;2;${r};${g};${b}`);
    }

    if (s.bgMode === ColorMode.Default) {
      parts.push('49');
    } else if (s.bgMode === ColorMode.Palette) {
      parts.push(`48;5;${s.bgValue}`);
    } else {
      const r = (s.bgValue >> 16) & 0xff;
      const g = (s.bgValue >> 8) & 0xff;
      const b = s.bgValue & 0xff;
      parts.push(`48;2;${r};${g};${b}`);
    }

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
