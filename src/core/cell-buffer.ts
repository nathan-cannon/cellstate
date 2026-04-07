/**
 * Packed cell buffer. Stores terminal cells as pairs of Int32 values in typed
 * arrays, with row-level dirty tracking and damage bounds.
 *
 * Cell encoding (2 consecutive Int32 values per cell):
 *   word0: charId (full 32 bits, index into CharTable)
 *   word1: bits [31:17] = styleId (15 bits)
 *          bits [16:2]  = linkId  (15 bits)
 *          bits [1:0]   = width   (2 bits)
 *
 * Width encoding is chosen so that a blank cell is all-zero:
 *   0 = normal (single column)   ← blank cells use this
 *   1 = wide (first column of double-wide char)
 *   2 = continuation (second column of double-wide char)
 */
import { SPACE_CHAR, type CharTable } from './char-table.js';
import { DEFAULT_STYLE, type StyleTable } from './style-table.js';
import { NO_LINK, type LinkTable } from './link-table.js';

// --- Width constants ---

/** Normal single-column character. Encoded as 0 so blank cells are all-zero. */
export const NORMAL_WIDTH = 0;
/** First column of a double-wide character. */
export const WIDE_WIDTH = 1;
/** Second column of a double-wide character (continuation). */
export const CONTINUATION_WIDTH = 2;

// --- Bit layout constants ---

export const WIDTH_SHIFT = 0;
export const WIDTH_MASK = 0x3;
export const LINK_SHIFT = 2;
export const LINK_MASK = 0x7fff; // 15 bits
export const STYLE_SHIFT = 17;
export const STYLE_MASK = 0x7fff; // 15 bits

/** Pack styleId, linkId, and width into word1. */
export function packMeta(styleId: number, linkId: number, width: number): number {
  return (styleId << STYLE_SHIFT) | (linkId << LINK_SHIFT) | (width << WIDTH_SHIFT);
}

// --- Blank cell constants ---

/** The two Int32 values for a blank cell: [charId=0, meta=0]. */
export const BLANK_CELL_PAIR: [number, number] = [SPACE_CHAR, packMeta(DEFAULT_STYLE, NO_LINK, NORMAL_WIDTH)];

/** BigInt64 value for a blank cell. Since blank = all-zero, this is 0n. */
export const BLANK_CELL_64 = 0n;

// --- Buffer type ---

export interface DamageBox {
  minRow: number;
  maxRow: number;
  minCol: number;
  maxCol: number;
}

export interface CellBuffer {
  width: number;
  height: number;
  capacity: number;
  cellWords: Int32Array;
  cellBulk: BigInt64Array;
  damageBox: DamageBox | null;
}

// --- Allocation ---

export function createCellBuffer(width: number, height: number): CellBuffer {
  const byteLength = width * height * 8; // 2 Int32 per cell, 4 bytes each
  const ab = new ArrayBuffer(byteLength);
  // All-zero init = all blank cells (SPACE_CHAR=0, DEFAULT_STYLE=0, NO_LINK=0, NORMAL_WIDTH=0)
  return {
    width,
    height,
    capacity: height,
    cellWords: new Int32Array(ab),
    cellBulk: new BigInt64Array(ab),
    damageBox: null,
  };
}

// --- Clear ---

export function clearBuffer(buf: CellBuffer): void {
  buf.cellBulk.fill(BLANK_CELL_64, 0, buf.width * buf.height);
  buf.damageBox = null;
}

// --- Resize ---

export function resizeBuffer(buf: CellBuffer, newWidth: number, newHeight: number): CellBuffer {
  if (newWidth <= buf.width && newHeight <= buf.capacity) {
    // Reuse existing backing arrays — just update dimensions and clear
    buf.width = newWidth;
    buf.height = newHeight;
    clearBuffer(buf);
    return buf;
  }
  // Allocate exact-sized backing arrays — spare buffer reuse in the frame
  // loop already avoids redundant allocations in steady state.
  const newCapacity = Math.floor(newHeight);
  const byteLength = newWidth * newCapacity * 8;
  const ab = new ArrayBuffer(byteLength);
  buf.width = newWidth;
  buf.height = newHeight;
  buf.capacity = newCapacity;
  buf.cellWords = new Int32Array(ab);
  buf.cellBulk = new BigInt64Array(ab);
  buf.damageBox = null;
  return buf;
}

// --- Cell access ---

function expandDamage(buf: CellBuffer, row: number, col: number): void {
  if (buf.damageBox === null) {
    buf.damageBox = { minRow: row, maxRow: row, minCol: col, maxCol: col };
  } else {
    const d = buf.damageBox;
    if (row < d.minRow) d.minRow = row;
    if (row > d.maxRow) d.maxRow = row;
    if (col < d.minCol) d.minCol = col;
    if (col > d.maxCol) d.maxCol = col;
  }
}

export function writeCell(
  buf: CellBuffer,
  row: number,
  col: number,
  charId: number,
  styleId: number,
  linkId: number,
  width: number,
): void {
  if (row < 0 || row >= buf.height || col < 0 || col >= buf.width) return;
  const offset = (row * buf.width + col) * 2;
  buf.cellWords[offset] = charId;
  buf.cellWords[offset + 1] = packMeta(styleId, linkId, width);
  expandDamage(buf, row, col);
}

export function readCell(
  buf: CellBuffer,
  row: number,
  col: number,
): { charId: number; styleId: number; linkId: number; width: number } | null {
  if (row < 0 || row >= buf.height || col < 0 || col >= buf.width) return null;
  const offset = (row * buf.width + col) * 2;
  const word0 = buf.cellWords[offset]!;
  const word1 = buf.cellWords[offset + 1]!;
  return {
    charId: word0,
    styleId: (word1 >>> STYLE_SHIFT) & STYLE_MASK,
    linkId: (word1 >>> LINK_SHIFT) & LINK_MASK,
    width: (word1 >>> WIDTH_SHIFT) & WIDTH_MASK,
  };
}

export function readCellCharId(buf: CellBuffer, row: number, col: number): number {
  const offset = (row * buf.width + col) * 2;
  return buf.cellWords[offset]!;
}

export function readCellMeta(buf: CellBuffer, row: number, col: number): number {
  const offset = (row * buf.width + col) * 2;
  return buf.cellWords[offset + 1]!;
}

// --- Row operations ---

export function blitRegion(
  src: CellBuffer,
  dst: CellBuffer,
  srcRow: number,
  srcCol: number,
  dstRow: number,
  dstCol: number,
  rows: number,
  cols: number,
): void {
  // Clamp row range to valid bounds in both buffers
  let rStart = 0;
  if (srcRow < 0) rStart = -srcRow;
  if (dstRow < 0) rStart = Math.max(rStart, -dstRow);
  let rEnd = rows;
  if (srcRow + rEnd > src.height) rEnd = src.height - srcRow;
  if (dstRow + rEnd > dst.height) rEnd = dst.height - dstRow;
  if (rStart >= rEnd) return;

  // Clamp column range to valid bounds in both buffers
  let cStart = 0;
  if (srcCol < 0) cStart = -srcCol;
  if (dstCol < 0) cStart = Math.max(cStart, -dstCol);
  let cEnd = cols;
  if (srcCol + cEnd > src.width) cEnd = src.width - srcCol;
  if (dstCol + cEnd > dst.width) cEnd = dst.width - dstCol;
  if (cStart >= cEnd) return;

  const actualCols = cEnd - cStart;
  const effectiveSrcCol = srcCol + cStart;
  const effectiveDstCol = dstCol + cStart;
  const effectiveSrcRow = srcRow + rStart;
  const effectiveDstRow = dstRow + rStart;
  const actualRows = rEnd - rStart;
  const wordsPerCell = 2;

  // Full-width fast path: single bulk copy when rows are contiguous in both buffers
  if (effectiveSrcCol === 0 && effectiveDstCol === 0 &&
      actualCols === src.width && actualCols === dst.width) {
    const srcStart = effectiveSrcRow * src.width * wordsPerCell;
    const dstStart = effectiveDstRow * dst.width * wordsPerCell;
    const len = actualRows * actualCols * wordsPerCell;
    dst.cellWords.set(src.cellWords.subarray(srcStart, srcStart + len), dstStart);
  } else {
    // Per-row path: one TypedArray.set() call per row
    const copyWords = actualCols * wordsPerCell;
    for (let r = 0; r < actualRows; r++) {
      const sr = effectiveSrcRow + r;
      const dr = effectiveDstRow + r;
      const srcOff = (sr * src.width + effectiveSrcCol) * wordsPerCell;
      const dstOff = (dr * dst.width + effectiveDstCol) * wordsPerCell;
      dst.cellWords.set(src.cellWords.subarray(srcOff, srcOff + copyWords), dstOff);
    }
  }

  // Wide character boundary fix: if the last copied column contains WIDE_WIDTH
  // and there's a column after it in the destination, write a continuation cell
  // so the wide char doesn't lose its second half.
  const lastDstCol = effectiveDstCol + actualCols - 1;
  if (lastDstCol + 1 < dst.width) {
    for (let r = 0; r < actualRows; r++) {
      const dr = effectiveDstRow + r;
      const offset = (dr * dst.width + lastDstCol) * wordsPerCell;
      const meta = dst.cellWords[offset + 1]!;
      if ((meta & WIDTH_MASK) === WIDE_WIDTH) {
        const contOff = offset + wordsPerCell;
        dst.cellWords[contOff] = SPACE_CHAR;
        dst.cellWords[contOff + 1] = packMeta(DEFAULT_STYLE, NO_LINK, CONTINUATION_WIDTH);
      }
    }
  }

  // blitRegion does NOT expand damage — blitted content is identical in
  // front and back, so the diff will find no changes.  Keeping damage tight
  // ensures the unreachable-row pre-paint only triggers when actual content
  // changes exist above the reachable line.
}

export function shiftRows(
  buf: CellBuffer,
  startRow: number,
  endRow: number,
  delta: number,
): void {
  const w = buf.width;
  if (delta > 0) {
    // Shift down: iterate from bottom to top to avoid overwrites
    for (let r = endRow - 1; r >= startRow; r--) {
      const dst = r + delta;
      if (dst < 0 || dst >= buf.height) continue;
      const srcOff = r * w * 2;
      const dstOff = dst * w * 2;
      buf.cellWords.copyWithin(dstOff, srcOff, srcOff + w * 2);
    }
    // Fill vacated rows (from startRow to startRow + delta - 1) with blanks
    for (let r = startRow; r < Math.min(startRow + delta, endRow); r++) {
      if (r < 0 || r >= buf.height) continue;
      buf.cellBulk.fill(BLANK_CELL_64, r * w, (r + 1) * w);
    }
  } else if (delta < 0) {
    // Shift up: iterate from top to bottom
    for (let r = startRow; r < endRow; r++) {
      const dst = r + delta;
      if (dst < 0 || dst >= buf.height) continue;
      const srcOff = r * w * 2;
      const dstOff = dst * w * 2;
      buf.cellWords.copyWithin(dstOff, srcOff, srcOff + w * 2);
    }
    // Fill vacated rows (from endRow + delta to endRow - 1) with blanks
    for (let r = Math.max(endRow + delta, startRow); r < endRow; r++) {
      if (r < 0 || r >= buf.height) continue;
      buf.cellBulk.fill(BLANK_CELL_64, r * w, (r + 1) * w);
    }
  }
}

// --- Content ceiling ---

export function applyContentCeiling(buf: CellBuffer, maxHeight: number): number {
  if (buf.height <= maxHeight) return 0;
  const drop = buf.height - maxHeight;
  // Shift data up by `drop` rows
  const w = buf.width;
  buf.cellWords.copyWithin(0, drop * w * 2, buf.height * w * 2);
  // Clear the vacated bottom rows
  buf.cellBulk.fill(BLANK_CELL_64, maxHeight * w, buf.height * w);
  buf.height = maxHeight;
  buf.damageBox = null;
  return drop;
}

// --- Damage helpers ---

export function isDamaged(buf: CellBuffer): boolean {
  return buf.damageBox !== null;
}


export function lastNonBlankRow(buf: CellBuffer): number {
  const w = buf.width;
  for (let r = buf.height - 1; r >= 0; r--) {
    const baseCell = r * w;
    for (let c = 0; c < w; c++) {
      if (buf.cellBulk[baseCell + c] !== BLANK_CELL_64) return r;
    }
  }
  return 0;
}

// --- Viewport slicing ---

/**
 * Create a zero-copy CellBuffer view into a contiguous row range of an
 * existing buffer.  Uses TypedArray.subarray() so no cell data is copied.
 * The returned buffer shares the same underlying ArrayBuffer — mutations
 * to the slice are visible in the original and vice-versa.
 */
export function viewportSlice(
  buf: CellBuffer,
  startRow: number,
  rows: number,
): CellBuffer {
  const w = buf.width;
  const actualRows = Math.min(rows, Math.max(0, buf.height - startRow));
  if (actualRows <= 0) {
    return createCellBuffer(w, rows);
  }
  // Transform damageBox from full-buffer to slice coordinates
  let sliceDamage: DamageBox | null = null;
  if (buf.damageBox) {
    const dMinRow = Math.max(0, buf.damageBox.minRow - startRow);
    const dMaxRow = Math.min(actualRows - 1, buf.damageBox.maxRow - startRow);
    if (dMinRow <= dMaxRow) {
      sliceDamage = {
        minRow: dMinRow,
        maxRow: dMaxRow,
        minCol: buf.damageBox.minCol,
        maxCol: Math.min(buf.damageBox.maxCol, w - 1),
      };
    }
  }
  const wordOffset = startRow * w * 2;
  const cellOffset = startRow * w;
  return {
    width: w,
    height: actualRows,
    capacity: actualRows,
    cellWords: buf.cellWords.subarray(wordOffset, wordOffset + actualRows * w * 2),
    cellBulk: buf.cellBulk.subarray(cellOffset, cellOffset + actualRows * w),
    damageBox: sliceDamage,
  };
}

/**
 * Expand damage for content shrink.
 *
 * After incremental paint, rows that are neither painted nor blitted remain
 * zero-filled (blank) with no damage. When content shrinks, some of these
 * blank rows correspond to front-buffer rows that had content — the diff
 * engine needs them within the damage bounds to emit erase sequences.
 *
 * This is O(overlap_rows) in the scan and O(width) only for the rows that
 * actually need checking (rows outside current damage, non-blank in front).
 */
export function expandDamageForShrink(front: CellBuffer, back: CellBuffer): void {
  const overlap = Math.min(front.height, back.height);
  const w = back.width;
  if (front.width !== w) return;
  for (let r = 0; r < overlap; r++) {
    // Skip rows already within damage box
    if (back.damageBox && r >= back.damageBox.minRow && r <= back.damageBox.maxRow) continue;
    // Check if front row has any content
    const base = r * w;
    let frontHasContent = false;
    for (let c = 0; c < w; c++) {
      if (front.cellBulk[base + c] !== BLANK_CELL_64) {
        frontHasContent = true;
        break;
      }
    }
    if (!frontHasContent) continue;
    // Back row is blank but front had content → expand damage to include this row
    let backIsBlank = true;
    for (let c = 0; c < w; c++) {
      if (back.cellBulk[base + c] !== BLANK_CELL_64) {
        backIsBlank = false;
        break;
      }
    }
    if (backIsBlank) {
      expandDamage(back, r, 0);
      expandDamage(back, r, w - 1);
    }
  }
}


// --- Debug helpers ---

export function bufferToText(buf: CellBuffer, charTable: CharTable): string {
  const lines: string[] = [];
  for (let r = 0; r < buf.height; r++) {
    let line = '';
    for (let c = 0; c < buf.width; c++) {
      const offset = (r * buf.width + c) * 2;
      const charId = buf.cellWords[offset]!;
      const meta = buf.cellWords[offset + 1]!;
      const width = (meta >>> WIDTH_SHIFT) & WIDTH_MASK;
      if (width === CONTINUATION_WIDTH) continue; // skip continuation cells
      line += charTable.resolve(charId);
    }
    lines.push(line.trimEnd());
  }
  return lines.join('\n');
}

export function bufferToAnnotatedText(
  buf: CellBuffer,
  charTable: CharTable,
  styleTable: StyleTable,
  linkTable: LinkTable,
): string {
  const output: string[] = [];
  for (let r = 0; r < buf.height; r++) {
    let textLine = '';
    const annotations: string[] = [];
    for (let c = 0; c < buf.width; c++) {
      const offset = (r * buf.width + c) * 2;
      const charId = buf.cellWords[offset]!;
      const meta = buf.cellWords[offset + 1]!;
      const styleId = (meta >>> STYLE_SHIFT) & STYLE_MASK;
      const linkId = (meta >>> LINK_SHIFT) & LINK_MASK;
      const width = (meta >>> WIDTH_SHIFT) & WIDTH_MASK;
      if (width === CONTINUATION_WIDTH) continue;
      textLine += charTable.resolve(charId);
      if (styleId !== DEFAULT_STYLE || linkId !== NO_LINK || width !== NORMAL_WIDTH) {
        const parts: string[] = [`col=${c}`];
        if (styleId !== DEFAULT_STYLE) parts.push(`style=${styleId}`);
        if (linkId !== NO_LINK) {
          const uri = linkTable.resolve(linkId);
          parts.push(`link=${linkId}(${uri})`);
        }
        if (width !== NORMAL_WIDTH) {
          parts.push(`w=${width === WIDE_WIDTH ? 'wide' : 'cont'}`);
        }
        annotations.push(parts.join(' '));
      }
    }
    output.push(textLine.trimEnd());
    for (const ann of annotations) {
      output.push(`  ${ann}`);
    }
  }
  return output.join('\n');
}
