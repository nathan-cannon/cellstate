/**
 * Cell grid primitives. A CellGrid is the shared data structure between the
 * rasterizer (writes cells) and the diff engine (reads cells to produce ANSI).
 */
import type { Perf } from './perf.js';

/**
 * Color mode matches xterm's internal representation:
 *   0 = default (terminal's default fg/bg)
 *   1 = palette (16 basic + 256 extended colors, value 0–255)
 *   2 = rgb (24-bit truecolor, value = r<<16 | g<<8 | b)
 */
export const enum ColorMode {
  Default = 0,
  Palette = 1,
  RGB = 2,
}

export interface Color {
  mode: ColorMode;
  value: number; // palette index (0–255) or 0xRRGGBB
}

export const DEFAULT_COLOR: Color = { mode: ColorMode.Default, value: 0 };

/**
 * Attribute bit flags.
 */
export const enum Attr {
  Bold = 1,
  Italic = 2,
  Underline = 4,
  Strikethrough = 8,
  Dim = 16,
  Inverse = 32,
}

export interface Cell {
  char: string; // single character (' ' for empty), or '' for wide-char continuation
  width: number; // 0 = continuation, 1 = normal, 2 = wide
  fg: Color;
  bg: Color;
  attrs: number; // bitmask of Attr flags
}

export interface CellGrid {
  cells: Cell[][]; // rows × cols
  cursorRow: number;
  cursorCol: number;
  width: number;
  height: number;
}

function emptyCell(): Cell {
  return {
    char: " ",
    width: 1,
    fg: { ...DEFAULT_COLOR },
    bg: { ...DEFAULT_COLOR },
    attrs: 0,
  };
}

export function createGrid(width: number, height: number, perf?: Perf): CellGrid {
  if (perf) {
    perf.timeStart('createGrid');
    perf.count('createGridCalls');
    perf.count('createGridRows', height);
    perf.count('createGridCells', width * height);
  }
  const cells: Cell[][] = [];
  for (let r = 0; r < height; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < width; c++) {
      row.push(emptyCell());
    }
    cells.push(row);
  }
  if (perf) perf.timeEnd('createGrid');
  return { cells, cursorRow: 0, cursorCol: 0, width, height };
}

export function colorsEqual(a: Color, b: Color): boolean {
  return a.mode === b.mode && a.value === b.value;
}

export function cellsEqual(a: Cell, b: Cell): boolean {
  return (
    a.char === b.char &&
    a.width === b.width &&
    a.attrs === b.attrs &&
    colorsEqual(a.fg, b.fg) &&
    colorsEqual(a.bg, b.bg)
  );
}

/** Render grid as plain text (for test output / debugging). */
export function gridToDebugString(grid: CellGrid): string {
  return grid.cells
    .map((row) => row.map((c) => c.char || " ").join(""))
    .map((line) => line.trimEnd())
    .join("\n");
}
