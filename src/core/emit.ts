/**
 * Buffer-based diff engine and ANSI emission.
 *
 * Uses damage rectangles on CellBuffers to scope the diff iteration region.
 * Within the damage bounds, cells are compared word-by-word and only changed
 * cells produce cursor movement + style transition + character output.
 */
import {
  type CellBuffer,
  BLANK_CELL_64,
  NORMAL_WIDTH,
  WIDE_WIDTH,
  CONTINUATION_WIDTH,
  WIDTH_SHIFT,
  WIDTH_MASK,
  STYLE_SHIFT,
  STYLE_MASK,
  LINK_SHIFT,
  LINK_MASK,
  lastNonBlankRow,
} from './cell-buffer.js';
import { type StyleTable, DEFAULT_STYLE } from './style-table.js';
import { type CharTable, SPACE_CHAR } from './char-table.js';
import { type LinkTable, NO_LINK } from './link-table.js';
import type { Perf } from './perf.js';

const ESC = '\x1b[';

// --- OSC 8 hyperlink sequences ---

const OSC8_CLOSE = '\x1b]8;;\x1b\\';

/** djb2 hash → base-36 string for deterministic link id= parameter. */
function hashUri(uri: string): string {
  let h = 5381;
  for (let i = 0; i < uri.length; i++) {
    h = ((h << 5) + h + uri.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

function osc8Open(uri: string): string {
  return `\x1b]8;id=${hashUri(uri)};${uri}\x1b\\`;
}

/** Emit link close (if active) and link open (if new link is active). */
function transitionLink(
  curLinkId: number,
  newLinkId: number,
  linkTable: LinkTable,
): string {
  let seq = '';
  if (curLinkId !== NO_LINK) seq += OSC8_CLOSE;
  if (newLinkId !== NO_LINK) {
    const uri = linkTable.resolve(newLinkId);
    if (uri) seq += osc8Open(uri);
  }
  return seq;
}

// --- Emoji width compensation ---

/**
 * Returns true if the character may be rendered as width 1 by terminals
 * whose wcwidth tables disagree with Unicode:
 *  1. Codepoints in U+1FA70–U+1FAFF or U+1FB00–U+1FBFF (Unicode 12.0+ blocks)
 *  2. Text-presentation emoji upgraded to width 2 by VS16 (U+FE0F)
 */
function requiresCursorFix(char: string): boolean {
  const cp = char.codePointAt(0)!;
  if (cp >= 0x1FA70 && cp <= 0x1FBFF) return true;
  if (char.length >= 2) {
    for (let i = 0; i < char.length; i++) {
      if (char.charCodeAt(i) === 0xFE0F) return true;
    }
  }
  return false;
}

/**
 * Emit a wide character with cursor-position fixups so that terminals
 * whose wcwidth only advances 1 column still render correctly.
 */
function emitWideCharWithFix(char: string, col: number, screenWidth: number): string {
  let seq = '';
  // Pre-fill the second cell with a space so stale content doesn't show
  if (col + 1 < screenWidth) {
    seq += `${ESC}${col + 2}G ${ESC}${col + 1}G`;
  }
  // Emit the actual character
  seq += char;
  // Force cursor to the correct post-character column
  seq += `${ESC}${col + 3}G`;
  return seq;
}

// --- Cursor movement ---

/**
 * Structured cursor for inline rendering. Tracks mutable row/col state,
 * accumulates output into an internal buffer, and emits relative ANSI
 * sequences (CUU/CUD/CHA) — never CUP.
 */
export class InlineCursor {
  col: number;
  row: number;
  private buf: string = '';
  private readonly viewportWidth: number;

  constructor(col: number, row: number, viewportWidth: number) {
    this.col = col;
    this.row = row;
    this.viewportWidth = viewportWidth;
  }

  get output(): string {
    return this.buf;
  }

  /**
   * Emit relative sequences to move from current position to (targetCol, targetRow).
   * Handles pending-wrap state (col >= viewportWidth) by emitting \r first.
   */
  moveTo(targetCol: number, targetRow: number): void {
    // Resolve pending wrap state without advancing to next line
    if (this.col >= this.viewportWidth) {
      this.buf += '\r';
      this.col = 0;
    }

    const dRow = targetRow - this.row;
    if (dRow !== 0) {
      // Cross-line move: always \r first to go to col 0, then vertical, then CHA
      this.buf += '\r';
      if (dRow < 0) this.buf += `${ESC}${-dRow}A`;
      else this.buf += `${ESC}${dRow}B`;
      if (targetCol !== 0) this.buf += `${ESC}${targetCol + 1}G`;
    } else {
      // Same-line move
      if (targetCol !== this.col) this.buf += `${ESC}${targetCol + 1}G`;
    }

    this.col = targetCol;
    this.row = targetRow;
  }

  /** Update col after writing a visible character. Does NOT auto-advance row on wrap. */
  advance(cols: number): void {
    this.col += cols;
  }

  /** Emit \r\n — creates a new line (scrolls at bottom margin). */
  newline(): void {
    this.buf += '\r\n';
    this.col = 0;
    this.row += 1;
  }

  /** Append raw string (SGR, OSC, EL, etc.) without updating cursor position. */
  writeRaw(str: string): void {
    this.buf += str;
  }
}

// --- Row helpers ---

/** Returns true if every cell in a buffer row is blank. */
function isBlankRow(buf: CellBuffer, row: number): boolean {
  const w = buf.width;
  const base = row * w;
  for (let c = 0; c < w; c++) {
    if (buf.cellBulk[base + c] !== BLANK_CELL_64) return false;
  }
  return true;
}

/** Returns true if every cell from startCol to width-1 is blank. */
function isBlankFrom(buf: CellBuffer, row: number, startCol: number): boolean {
  const w = buf.width;
  const base = row * w;
  for (let c = startCol; c < w; c++) {
    if (buf.cellBulk[base + c] !== BLANK_CELL_64) return false;
  }
  return true;
}

/** Returns the index of the rightmost non-blank cell, or -1 if entirely blank. */
function lastContentCol(buf: CellBuffer, row: number): number {
  const w = buf.width;
  const base = row * w;
  for (let c = w - 1; c >= 0; c--) {
    if (buf.cellBulk[base + c] !== BLANK_CELL_64) return c;
  }
  return -1;
}

// --- Core diff ---

export function diffBuffers(
  front: CellBuffer,
  back: CellBuffer,
  styleTable: StyleTable,
  charTable: CharTable,
  linkTable: LinkTable,
  hyperlinksEnabled: boolean,
  cursor: InlineCursor,
  perf?: Perf,
): void {
  const width = back.width;
  const height = back.height;
  const frontHeight = front.height;

  // Compute iteration row range from the union of front and back damage rects.
  const fd = front.damageBox;
  const bd = back.damageBox;

  if (fd === null && bd === null) return;

  let minRow: number, maxRow: number;
  if (fd === null) {
    minRow = bd!.minRow;
    maxRow = bd!.maxRow;
  } else if (bd === null) {
    minRow = fd.minRow;
    maxRow = fd.maxRow;
  } else {
    minRow = Math.min(fd.minRow, bd.minRow);
    maxRow = Math.max(fd.maxRow, bd.maxRow);
  }

  // Clamp to viewport slice bounds
  minRow = Math.max(0, minRow);
  maxRow = Math.min(height - 1, maxRow);

  if (minRow > maxRow) return;

  // Track damage stats
  if (perf) {
    const damageRows = maxRow - minRow + 1;
    perf.count('damageCells', damageRows * width);
    perf.count('damageSkippedCells', (height - damageRows) * width);
  }

  let curStyleId = DEFAULT_STYLE;
  let curLinkId = NO_LINK;
  let styleKnown = false;

  for (let r = minRow; r <= maxRow; r++) {
    const isNewRow = r >= frontHeight;

    // Check: entire back row is blank but front had content → bulk erase
    if (!isNewRow && isBlankRow(back, r) && !isBlankRow(front, r)) {
      if (cursor.row !== r || cursor.col !== 0) {
        cursor.moveTo(0, r);
      }
      if (hyperlinksEnabled && curLinkId !== NO_LINK) {
        cursor.writeRaw(OSC8_CLOSE);
        curLinkId = NO_LINK;
      }
      if (!styleKnown || curStyleId !== DEFAULT_STYLE) {
        cursor.writeRaw(`${ESC}0m`);
        curStyleId = DEFAULT_STYLE;
      }
      styleKnown = true;
      cursor.writeRaw(`${ESC}2K`);
      continue;
    }

    for (let c = 0; c < width; c++) {
      const backOffset = (r * width + c) * 2;
      const backW0 = back.cellWords[backOffset]!;
      const backW1 = back.cellWords[backOffset + 1]!;
      const backWidth = (backW1 >>> WIDTH_SHIFT) & WIDTH_MASK;

      // Skip continuation cells
      if (backWidth === CONTINUATION_WIDTH) continue;

      // Compare with front if the row existed
      if (!isNewRow && front.width === width) {
        const frontOffset = (r * width + c) * 2;
        if (back.cellWords[backOffset] === front.cellWords[frontOffset] &&
            back.cellWords[backOffset + 1] === front.cellWords[backOffset + 1]) {
          // Wide char: also check continuation cell
          if (backWidth === WIDE_WIDTH && c + 1 < width) {
            const bCont = (r * width + c + 1) * 2;
            const fCont = (r * width + c + 1) * 2;
            if (back.cellWords[bCont] === front.cellWords[fCont] &&
                back.cellWords[bCont + 1] === front.cellWords[fCont + 1]) {
              continue;
            }
          } else {
            continue;
          }
        }
      }

      // Check: changed cell is blank and all remaining cells are blank → erase to EOL
      if (backW0 === SPACE_CHAR && backW1 === 0 && isBlankFrom(back, r, c)) {
        // Only emit erase if front had content here
        if (isNewRow) break; // new row, blank from here → nothing to emit
        if (isBlankFrom(front, r, c)) break; // front was also blank → skip

        if (cursor.row !== r || cursor.col !== c) {
          cursor.moveTo(c, r);
        }
        if (hyperlinksEnabled && curLinkId !== NO_LINK) {
          cursor.writeRaw(OSC8_CLOSE);
          curLinkId = NO_LINK;
        }
        if (!styleKnown || curStyleId !== DEFAULT_STYLE) {
          cursor.writeRaw(`${ESC}0m`);
          curStyleId = DEFAULT_STYLE;
        }
        styleKnown = true;
        cursor.writeRaw(`${ESC}0K`);
        break;
      }

      // Position cursor
      if (cursor.row !== r || cursor.col !== c) {
        cursor.moveTo(c, r);
      }

      // Style transition
      const backStyleId = (backW1 >>> STYLE_SHIFT) & STYLE_MASK;
      if (!styleKnown) {
        cursor.writeRaw(`${ESC}0m`);
        if (backStyleId !== DEFAULT_STYLE) {
          cursor.writeRaw(styleTable.transition(DEFAULT_STYLE, backStyleId));
        }
        curStyleId = backStyleId;
        styleKnown = true;
      } else if (backStyleId !== curStyleId) {
        cursor.writeRaw(styleTable.transition(curStyleId, backStyleId));
        curStyleId = backStyleId;
      }

      // Link transition
      if (hyperlinksEnabled) {
        const backLinkId = (backW1 >>> LINK_SHIFT) & LINK_MASK;
        if (backLinkId !== curLinkId) {
          cursor.writeRaw(transitionLink(curLinkId, backLinkId, linkTable));
          curLinkId = backLinkId;
        }
      }

      // Write character
      const ch = charTable.resolve(backW0);
      if (backWidth === WIDE_WIDTH && requiresCursorFix(ch)) {
        cursor.writeRaw(emitWideCharWithFix(ch, cursor.col, width));
        cursor.advance(2);
      } else {
        cursor.writeRaw(ch);
        cursor.advance(backWidth === WIDE_WIDTH ? 2 : 1);
      }

      // If front had a wide char here but back has narrow, clear orphan
      if (!isNewRow && backWidth === NORMAL_WIDTH && c + 1 < width) {
        const frontOffset = (r * width + c) * 2;
        const frontW1 = front.cellWords[frontOffset + 1]!;
        const frontWidth = (frontW1 >>> WIDTH_SHIFT) & WIDTH_MASK;
        if (frontWidth === WIDE_WIDTH) {
          cursor.writeRaw(' ');
          cursor.advance(1);
        }
      }
    }
  }

  // Erase rows that existed in front but not in back (content shrink).
  // The back buffer is physically shorter so these rows can't be in its
  // damage rect — handle them as a separate pass.
  if (frontHeight > height) {
    for (let r = height; r < frontHeight; r++) {
      if (isBlankRow(front, r)) continue;
      if (cursor.row !== r || cursor.col !== 0) {
        cursor.moveTo(0, r);
      }
      if (hyperlinksEnabled && curLinkId !== NO_LINK) {
        cursor.writeRaw(OSC8_CLOSE);
        curLinkId = NO_LINK;
      }
      if (!styleKnown || curStyleId !== DEFAULT_STYLE) {
        cursor.writeRaw(`${ESC}0m`);
        curStyleId = DEFAULT_STYLE;
      }
      styleKnown = true;
      cursor.writeRaw(`${ESC}2K`);
    }
  }

  if (hyperlinksEnabled && curLinkId !== NO_LINK) {
    cursor.writeRaw(OSC8_CLOSE);
  }
  if (cursor.output.length > 0 && styleKnown && curStyleId !== DEFAULT_STYLE) {
    cursor.writeRaw(`${ESC}0m`);
  }
}

// --- Serialization functions ---

/**
 * Serialize rows [startRow, endRow) as fresh content.
 * Uses pending-wrap row separator (space + backspace).
 * Resets style before each row separator.
 */
export function serializeNewRows(
  back: CellBuffer,
  startRow: number,
  endRow: number,
  styleTable: StyleTable,
  charTable: CharTable,
  linkTable: LinkTable,
  hyperlinksEnabled: boolean,
  cursor: InlineCursor,
  perf?: Perf,
): void {
  const width = back.width;
  let curStyleId = DEFAULT_STYLE;
  let curLinkId = NO_LINK;

  const lastRow = Math.min(endRow, back.height);

  for (let r = startRow; r < lastRow; r++) {
    const relRow = r - startRow;

    if (relRow > 0) {
      if (hyperlinksEnabled && curLinkId !== NO_LINK) {
        cursor.writeRaw(OSC8_CLOSE);
        curLinkId = NO_LINK;
      }
      if (curStyleId !== DEFAULT_STYLE) {
        cursor.writeRaw(`${ESC}0m`);
        curStyleId = DEFAULT_STYLE;
      }
      cursor.newline();
    }

    const colEnd = lastContentCol(back, r);

    for (let c = 0; c <= colEnd; c++) {
      const offset = (r * width + c) * 2;
      const w0 = back.cellWords[offset]!;
      const w1 = back.cellWords[offset + 1]!;
      const cellWidth = (w1 >>> WIDTH_SHIFT) & WIDTH_MASK;

      if (cellWidth === CONTINUATION_WIDTH) continue;

      const cellStyleId = (w1 >>> STYLE_SHIFT) & STYLE_MASK;
      if (cellStyleId !== curStyleId) {
        cursor.writeRaw(styleTable.transition(curStyleId, cellStyleId));
        curStyleId = cellStyleId;
      }

      if (hyperlinksEnabled) {
        const cellLinkId = (w1 >>> LINK_SHIFT) & LINK_MASK;
        if (cellLinkId !== curLinkId) {
          cursor.writeRaw(transitionLink(curLinkId, cellLinkId, linkTable));
          curLinkId = cellLinkId;
        }
      }

      const ch = charTable.resolve(w0);
      if (cellWidth === WIDE_WIDTH && requiresCursorFix(ch)) {
        cursor.writeRaw(emitWideCharWithFix(ch, cursor.col, width));
        cursor.advance(2);
      } else {
        cursor.writeRaw(ch);
        cursor.advance(cellWidth === WIDE_WIDTH ? 2 : 1);
      }
    }
  }

  if (hyperlinksEnabled && curLinkId !== NO_LINK) {
    cursor.writeRaw(OSC8_CLOSE);
  }
  if (cursor.output.length > 0 && curStyleId !== DEFAULT_STYLE) {
    cursor.writeRaw(`${ESC}0m`);
  }

  if (perf) {
    perf.count('growthRowsEmitted', lastRow - startRow);
  }
}

/**
 * Serialize all content rows using real newlines with SGR reset before
 * each newline. For exit repaint. Trims trailing spaces per row.
 */
export function serializeRowsForExit(
  back: CellBuffer,
  styleTable: StyleTable,
  charTable: CharTable,
  linkTable: LinkTable,
  hyperlinksEnabled: boolean,
): { output: string; endRow: number; endCol: number } {
  let out = '';
  let curRow = 0;
  let curCol = 0;
  let curStyleId = DEFAULT_STYLE;
  let curLinkId = NO_LINK;
  const width = back.width;

  const lastRow = lastNonBlankRow(back);

  for (let r = 0; r <= lastRow; r++) {
    if (r > 0) {
      if (hyperlinksEnabled && curLinkId !== NO_LINK) {
        out += OSC8_CLOSE;
        curLinkId = NO_LINK;
      }
      if (curStyleId !== DEFAULT_STYLE) {
        out += `${ESC}0m`;
        curStyleId = DEFAULT_STYLE;
      }
      out += '\n';
      curRow = r;
      curCol = 0;
    }

    const colEnd = lastContentCol(back, r);

    for (let c = 0; c <= colEnd; c++) {
      const offset = (r * width + c) * 2;
      const w0 = back.cellWords[offset]!;
      const w1 = back.cellWords[offset + 1]!;
      const cellWidth = (w1 >>> WIDTH_SHIFT) & WIDTH_MASK;

      if (cellWidth === CONTINUATION_WIDTH) continue;

      const cellStyleId = (w1 >>> STYLE_SHIFT) & STYLE_MASK;
      if (cellStyleId !== curStyleId) {
        out += styleTable.transition(curStyleId, cellStyleId);
        curStyleId = cellStyleId;
      }

      if (hyperlinksEnabled) {
        const cellLinkId = (w1 >>> LINK_SHIFT) & LINK_MASK;
        if (cellLinkId !== curLinkId) {
          out += transitionLink(curLinkId, cellLinkId, linkTable);
          curLinkId = cellLinkId;
        }
      }

      const ch = charTable.resolve(w0);
      if (cellWidth === WIDE_WIDTH && requiresCursorFix(ch)) {
        out += emitWideCharWithFix(ch, curCol, width);
      } else {
        out += ch;
      }
      curCol += cellWidth === WIDE_WIDTH ? 2 : 1;
    }
  }

  if (hyperlinksEnabled && curLinkId !== NO_LINK) {
    out += OSC8_CLOSE;
  }
  if (out.length > 0 && curStyleId !== DEFAULT_STYLE) {
    out += `${ESC}0m`;
  }

  return { output: out, endRow: curRow, endCol: curCol };
}

/**
 * Serialize a specific row range unconditionally (including blank rows).
 * Uses pending-wrap row separator. For scrollback row setup during growth.
 */
export function serializeRowRange(
  back: CellBuffer,
  startRow: number,
  endRow: number,
  styleTable: StyleTable,
  charTable: CharTable,
  linkTable: LinkTable,
  hyperlinksEnabled: boolean,
): { output: string; endRow: number; endCol: number } {
  const width = back.width;
  const cursor = new InlineCursor(0, 0, width);
  let curStyleId = DEFAULT_STYLE;
  let curLinkId = NO_LINK;

  const lastRow = Math.min(endRow, back.height);

  for (let r = startRow; r < lastRow; r++) {
    const relRow = r - startRow;

    if (relRow > 0) {
      if (hyperlinksEnabled && curLinkId !== NO_LINK) {
        cursor.writeRaw(OSC8_CLOSE);
        curLinkId = NO_LINK;
      }
      if (curStyleId !== DEFAULT_STYLE) {
        cursor.writeRaw(`${ESC}0m`);
        curStyleId = DEFAULT_STYLE;
      }
      cursor.newline();
    }

    const colEnd = lastContentCol(back, r);

    for (let c = 0; c <= colEnd; c++) {
      const offset = (r * width + c) * 2;
      const w0 = back.cellWords[offset]!;
      const w1 = back.cellWords[offset + 1]!;
      const cellWidth = (w1 >>> WIDTH_SHIFT) & WIDTH_MASK;

      if (cellWidth === CONTINUATION_WIDTH) continue;

      const cellStyleId = (w1 >>> STYLE_SHIFT) & STYLE_MASK;
      if (cellStyleId !== curStyleId) {
        cursor.writeRaw(styleTable.transition(curStyleId, cellStyleId));
        curStyleId = cellStyleId;
      }

      if (hyperlinksEnabled) {
        const cellLinkId = (w1 >>> LINK_SHIFT) & LINK_MASK;
        if (cellLinkId !== curLinkId) {
          cursor.writeRaw(transitionLink(curLinkId, cellLinkId, linkTable));
          curLinkId = cellLinkId;
        }
      }

      const ch = charTable.resolve(w0);
      if (cellWidth === WIDE_WIDTH && requiresCursorFix(ch)) {
        cursor.writeRaw(emitWideCharWithFix(ch, cursor.col, width));
        cursor.advance(2);
      } else {
        cursor.writeRaw(ch);
        cursor.advance(cellWidth === WIDE_WIDTH ? 2 : 1);
      }
    }
  }

  if (hyperlinksEnabled && curLinkId !== NO_LINK) {
    cursor.writeRaw(OSC8_CLOSE);
  }
  if (cursor.output.length > 0 && curStyleId !== DEFAULT_STYLE) {
    cursor.writeRaw(`${ESC}0m`);
  }

  return { output: cursor.output, endRow: cursor.row, endCol: cursor.col };
}

// --- Full serialize (for full-redraw) ---

export function serializeAll(
  back: CellBuffer,
  styleTable: StyleTable,
  charTable: CharTable,
  linkTable: LinkTable,
  hyperlinksEnabled: boolean,
  cursor: InlineCursor,
): void {
  const width = back.width;
  let curStyleId = DEFAULT_STYLE;
  let curLinkId = NO_LINK;

  for (let r = 0; r < back.height; r++) {
    if (r > 0) {
      if (hyperlinksEnabled && curLinkId !== NO_LINK) {
        cursor.writeRaw(OSC8_CLOSE);
        curLinkId = NO_LINK;
      }
      if (curStyleId !== DEFAULT_STYLE) {
        cursor.writeRaw(`${ESC}0m`);
        curStyleId = DEFAULT_STYLE;
      }
      cursor.newline();
    }

    const colEnd = lastContentCol(back, r);

    for (let c = 0; c <= colEnd; c++) {
      const offset = (r * width + c) * 2;
      const w0 = back.cellWords[offset]!;
      const w1 = back.cellWords[offset + 1]!;
      const cellWidth = (w1 >>> WIDTH_SHIFT) & WIDTH_MASK;

      if (cellWidth === CONTINUATION_WIDTH) continue;

      const cellStyleId = (w1 >>> STYLE_SHIFT) & STYLE_MASK;
      if (cellStyleId !== curStyleId) {
        cursor.writeRaw(styleTable.transition(curStyleId, cellStyleId));
        curStyleId = cellStyleId;
      }

      if (hyperlinksEnabled) {
        const cellLinkId = (w1 >>> LINK_SHIFT) & LINK_MASK;
        if (cellLinkId !== curLinkId) {
          cursor.writeRaw(transitionLink(curLinkId, cellLinkId, linkTable));
          curLinkId = cellLinkId;
        }
      }

      const ch = charTable.resolve(w0);
      if (cellWidth === WIDE_WIDTH && requiresCursorFix(ch)) {
        cursor.writeRaw(emitWideCharWithFix(ch, cursor.col, width));
        cursor.advance(2);
      } else {
        cursor.writeRaw(ch);
        cursor.advance(cellWidth === WIDE_WIDTH ? 2 : 1);
      }
    }
  }

  if (hyperlinksEnabled && curLinkId !== NO_LINK) {
    cursor.writeRaw(OSC8_CLOSE);
  }
  if (cursor.output.length > 0 && curStyleId !== DEFAULT_STYLE) {
    cursor.writeRaw(`${ESC}0m`);
  }

}

