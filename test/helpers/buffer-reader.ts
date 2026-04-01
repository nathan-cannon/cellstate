/** Reads an xterm.js Terminal buffer into a CellGrid. */
import type { IBufferNamespace } from "@xterm/headless";
import {
  createGrid,
  ColorMode,
  DEFAULT_COLOR,
  type CellGrid,
  type Color,
} from "../../src/core/cell.js";

// xterm.js exposes color modes as large integer constants (bitfield tags).
// These values come from xterm's internal AttributeData representation
// and are not documented in the public API.
const XTERM_CM_DEFAULT = 0;
const XTERM_CM_PALETTE = 33554432; // 0x2000000
const XTERM_CM_RGB = 50331648;     // 0x3000000

function toColor(value: number, mode: number): Color {
  if (mode === XTERM_CM_DEFAULT || value < 0) return { ...DEFAULT_COLOR };
  if (mode === XTERM_CM_RGB) return { mode: ColorMode.RGB, value };
  if (mode === XTERM_CM_PALETTE) return { mode: ColorMode.Palette, value };
  if (value >= 0 && value <= 255) return { mode: ColorMode.Palette, value };
  return { ...DEFAULT_COLOR };
}

function extractAttrs(cell: {
  isBold: () => number;
  isItalic: () => number;
  isUnderline: () => number;
  isStrikethrough: () => number;
  isDim: () => number;
  isInverse: () => number;
}): number {
  let attrs = 0;
  if (cell.isBold()) attrs |= 1;
  if (cell.isItalic()) attrs |= 2;
  if (cell.isUnderline()) attrs |= 4;
  if (cell.isStrikethrough()) attrs |= 8;
  if (cell.isDim()) attrs |= 16;
  if (cell.isInverse()) attrs |= 32;
  return attrs;
}

/**
 * Read the active buffer of an xterm Terminal into a CellGrid.
 * Shared by parseAnsi() and VirtualScreen.readGrid().
 *
 * When startRow is provided, reads rows [startRow, startRow + rows)
 * from the buffer instead of [0, rows). This is used by
 * readViewportGrid() to read only the visible viewport when content
 * has scrolled into scrollback.
 */
export function readBufferIntoGrid(
  buffer: IBufferNamespace,
  cols: number,
  rows: number,
  startRow: number = 0,
): CellGrid {
  const buf = buffer.active;
  const grid = createGrid(cols, rows);

  for (let r = 0; r < rows; r++) {
    const line = buf.getLine(startRow + r);
    if (!line) continue;

    for (let c = 0; c < cols; c++) {
      const xCell = line.getCell(c);
      if (!xCell) continue;

      const char = xCell.getChars();
      const width = xCell.getWidth();
      const fg = toColor(xCell.getFgColor(), xCell.getFgColorMode());
      const bg = toColor(xCell.getBgColor(), xCell.getBgColorMode());
      const attrs = extractAttrs(xCell);

      // width === 0 → wide-char continuation cell (keep as "")
      // width >= 1 with empty char → unfilled cell, normalize to " "
      // This ensures consistency: xterm reports both unfilled and
      // space-written cells identically after normalization.
      grid.cells[r][c] = {
        char: width === 0 ? "" : char || " ",
        width,
        fg,
        bg,
        attrs,
      };
    }
  }

  grid.cursorRow = buf.cursorY;
  grid.cursorCol = buf.cursorX;

  return grid;
}
