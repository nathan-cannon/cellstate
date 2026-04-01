/**
 * Cell-level diff engine and ANSI serialization.
 *
 * Compares two CellGrids and emits minimal ANSI to transform one into the
 * other. Only uses relative cursor movements (CUU/CUD/CHA), not absolute
 * CUP, so the output works in inline mode without an alternate screen.
 */
import {
  cellsEqual,
  colorsEqual,
  createGrid,
  ColorMode,
  DEFAULT_COLOR,
  type CellGrid,
  type Color,
} from "./cell.js";
import type { Perf } from './perf.js';

/** Find the last row that contains non-default content (non-space char, styled, or has attrs). */
export function lastContentRow(grid: CellGrid): number {
  for (let r = grid.height - 1; r >= 0; r--) {
    for (let c = 0; c < grid.width; c++) {
      const cell = grid.cells[r][c];
      if (cell.char !== " " || cell.fg.mode !== ColorMode.Default || cell.bg.mode !== ColorMode.Default || cell.attrs !== 0) {
        return r;
      }
    }
  }
  return 0;
}

const ESC = "\x1b[";


/** Convert our Color + attrs into an SGR escape sequence string. */
export function styleToAnsi(fg: Color, bg: Color, attrs: number): string {
  const parts: string[] = [];

  // Attributes
  if (attrs & 1) parts.push("1"); // bold
  if (attrs & 16) parts.push("2"); // dim
  if (attrs & 2) parts.push("3"); // italic
  if (attrs & 4) parts.push("4"); // underline
  if (attrs & 32) parts.push("7"); // inverse
  if (attrs & 8) parts.push("9"); // strikethrough

  // Foreground
  if (fg.mode === ColorMode.Default) {
    parts.push("39");
  } else if (fg.mode === ColorMode.Palette) {
    parts.push(`38;5;${fg.value}`);
  } else {
    const r = (fg.value >> 16) & 0xff;
    const g = (fg.value >> 8) & 0xff;
    const b = fg.value & 0xff;
    parts.push(`38;2;${r};${g};${b}`);
  }

  // Background
  if (bg.mode === ColorMode.Default) {
    parts.push("49");
  } else if (bg.mode === ColorMode.Palette) {
    parts.push(`48;5;${bg.value}`);
  } else {
    const r = (bg.value >> 16) & 0xff;
    const g = (bg.value >> 8) & 0xff;
    const b = bg.value & 0xff;
    parts.push(`48;2;${r};${g};${b}`);
  }

  return `${ESC}${parts.join(";")}m`;
}

function styleMatches(
  fg: Color,
  bg: Color,
  attrs: number,
  curFg: Color,
  curBg: Color,
  curAttrs: number
): boolean {
  return (
    attrs === curAttrs &&
    colorsEqual(fg, curFg) &&
    colorsEqual(bg, curBg)
  );
}

function colorSgrParams(color: Color, fgOrBg: 'fg' | 'bg'): string {
  if (color.mode === ColorMode.Default) {
    return fgOrBg === 'fg' ? '39' : '49';
  } else if (color.mode === ColorMode.Palette) {
    return fgOrBg === 'fg' ? `38;5;${color.value}` : `48;5;${color.value}`;
  } else {
    const r = (color.value >> 16) & 0xff;
    const g = (color.value >> 8) & 0xff;
    const b = color.value & 0xff;
    return fgOrBg === 'fg' ? `38;2;${r};${g};${b}` : `48;2;${r};${g};${b}`;
  }
}

/**
 * Compute the minimal SGR escape sequence to transition from one style to another.
 * Returns empty string if styles are identical, or a single \x1b[...m sequence.
 * Hot path, optimized with fast paths for common transitions.
 */
export function styleDelta(
  fromFg: Color, fromBg: Color, fromAttrs: number,
  toFg: Color, toBg: Color, toAttrs: number,
): string {
  // Fast path: identical styles
  if (fromAttrs === toAttrs && colorsEqual(fromFg, toFg) && colorsEqual(fromBg, toBg)) {
    return '';
  }

  const toIsDefault = toAttrs === 0 && toFg.mode === ColorMode.Default && toBg.mode === ColorMode.Default;

  // Target is fully default: just reset
  if (toIsDefault) {
    return `${ESC}0m`;
  }

  // Fast path: fg-only change (very common in syntax-highlighted code)
  if (fromAttrs === toAttrs && colorsEqual(fromBg, toBg)) {
    return `${ESC}${colorSgrParams(toFg, 'fg')}m`;
  }

  // Fast path: bg-only change
  if (fromAttrs === toAttrs && colorsEqual(fromFg, toFg)) {
    return `${ESC}${colorSgrParams(toBg, 'bg')}m`;
  }

  // Fast path: from default. Just emit full style (same as reset path minus the "0;")
  if (fromAttrs === 0 && fromFg.mode === ColorMode.Default && fromBg.mode === ColorMode.Default) {
    return styleToAnsi(toFg, toBg, toAttrs);
  }

  // General case: build both a targeted delta and a full reset path, pick shorter.
  let delta = '';

  // Attr transitions
  const added = toAttrs & ~fromAttrs;
  const removed = fromAttrs & ~toAttrs;

  // Bold (SGR 1) and Dim (SGR 2) share the same turn-off code (SGR 22).
  // When removing one while keeping the other, we must emit 22 first
  // (turning both off) then re-enable the one we want to keep.
  const removedBoldDim = removed & 0x11;
  if (removedBoldDim) {
    delta = '22';
    if ((toAttrs & 0x01) && (removedBoldDim & 0x10)) delta += ';1';
    if ((toAttrs & 0x10) && (removedBoldDim & 0x01)) delta += ';2';
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

  if (!colorsEqual(fromFg, toFg)) {
    const p = colorSgrParams(toFg, 'fg');
    delta += (delta ? ';' + p : p);
  }
  if (!colorsEqual(fromBg, toBg)) {
    const p = colorSgrParams(toBg, 'bg');
    delta += (delta ? ';' + p : p);
  }

  const deltaSeq = delta ? `${ESC}${delta}m` : '';

  // Reset path: \x1b[0;...non-default target params...m
  let reset = '0';
  if (toAttrs & 0x01) reset += ';1';
  if (toAttrs & 0x10) reset += ';2';
  if (toAttrs & 0x02) reset += ';3';
  if (toAttrs & 0x04) reset += ';4';
  if (toAttrs & 0x20) reset += ';7';
  if (toAttrs & 0x08) reset += ';9';
  if (toFg.mode !== ColorMode.Default) reset += ';' + colorSgrParams(toFg, 'fg');
  if (toBg.mode !== ColorMode.Default) reset += ';' + colorSgrParams(toBg, 'bg');
  const resetSeq = `${ESC}${reset}m`;

  return deltaSeq.length <= resetSeq.length ? deltaSeq : resetSeq;
}

/**
 * Emit relative cursor movement from (fromRow, fromCol) to (toRow, toCol).
 * Uses CUU/CUD for vertical, CHA (\x1b[nG) for horizontal.
 * CHA is column-absolute within the current line, so it's safe in inline mode.
 */
function moveCursor(
  fromRow: number,
  fromCol: number,
  toRow: number,
  toCol: number,
): string {
  let seq = "";
  const dRow = toRow - fromRow;
  if (dRow < 0) seq += `${ESC}${-dRow}A`;
  else if (dRow > 0) seq += `${ESC}${dRow}B`;
  if (toCol !== fromCol) seq += `${ESC}${toCol + 1}G`;
  return seq;
}

export interface DiffResult {
  output: string;
  endRow: number;
  endCol: number;
}

/**
 * Internal helper: serialize grid rows to ANSI using a caller-supplied row
 * separator function. Both `serializeRows` and `serializeRowsReflow` delegate
 * to this so the cell-emission loop is shared.
 */
function serializeRowsCore(
  grid: CellGrid,
  emitRowSeparator: (curFg: Color, curBg: Color, curAttrs: number) => { seq: string; fg: Color; bg: Color; attrs: number },
  trimTrailing?: boolean,
): DiffResult {
  let out = '';
  let curRow = 0;
  let curCol = 0;
  let curFg: Color = { ...DEFAULT_COLOR };
  let curBg: Color = { ...DEFAULT_COLOR };
  let curAttrs = 0;

  const lastRow = lastContentRow(grid);
  for (let r = 0; r <= lastRow; r++) {
    if (r > 0) {
      const sep = emitRowSeparator(curFg, curBg, curAttrs);
      out += sep.seq;
      curFg = sep.fg;
      curBg = sep.bg;
      curAttrs = sep.attrs;
      curRow = r;
      curCol = 0;
    }

    const colEnd = trimTrailing ? lastContentCol(grid, r) : grid.width - 1;

    for (let c = 0; c <= colEnd; c++) {
      const cell = grid.cells[r][c];

      // Skip wide-char continuation cells
      if (cell.width === 0) continue;

      // Emit style if needed
      if (!styleMatches(cell.fg, cell.bg, cell.attrs, curFg, curBg, curAttrs)) {
        out += styleDelta(curFg, curBg, curAttrs, cell.fg, cell.bg, cell.attrs);
        curFg = cell.fg;
        curBg = cell.bg;
        curAttrs = cell.attrs;
      }

      out += cell.char;
      curCol += cell.width;
    }
  }

  if (out.length > 0 && (curAttrs !== 0 || curFg.mode !== ColorMode.Default || curBg.mode !== ColorMode.Default)) {
    out += `${ESC}0m`;
  }

  return { output: out, endRow: curRow, endCol: curCol };
}

export function serializeRows(grid: CellGrid): DiffResult {
  return serializeRowsCore(grid, (curFg, curBg, curAttrs) => ({
    // Pending-wrap resolution: space triggers wrap to next row col 0,
    // backspace moves cursor back to col 0. No \n, no hard line break.
    seq: ' \x08',
    fg: curFg,
    bg: curBg,
    attrs: curAttrs,
  }));
}

/**
 * Like serializeRows but uses real newlines between rows instead of
 * pending-wrap (space+backspace). Resets SGR before each newline to prevent
 * background color bleed on reflow. Used for exit repaint and static rendering.
 */
export function serializeRowsReflow(grid: CellGrid): DiffResult {
  return serializeRowsCore(grid, (curFg, curBg, curAttrs) => {
    const hasStyle = curAttrs !== 0 || curFg.mode !== ColorMode.Default || curBg.mode !== ColorMode.Default;
    return {
      seq: (hasStyle ? `${ESC}0m` : '') + '\n',
      fg: hasStyle ? { ...DEFAULT_COLOR } : curFg,
      bg: hasStyle ? { ...DEFAULT_COLOR } : curBg,
      attrs: hasStyle ? 0 : curAttrs,
    };
  }, true);
}

export function fullRedraw(grid: CellGrid, cursorStartRow: number = grid.height - 1): DiffResult {
  let preamble = `${ESC}0m`; // reset style

  // Move from current cursor row to the top of the owned region
  if (cursorStartRow > 0) preamble += `${ESC}${cursorStartRow}A`;
  preamble += `${ESC}G`; // column 1 (CHA, within-line absolute, safe)

  const body = serializeRowsFull(grid);
  return {
    output: preamble + body.output,
    endRow: body.endRow,
    endCol: body.endCol,
  };
}

/**
 * Like serializeRows but writes ALL rows (not just to lastContentRow) and
 * erases each line before writing. This ensures stale terminal content is
 * cleared even for empty rows between content and a fixed bar.
 */
function serializeRowsFull(grid: CellGrid): DiffResult {
  let out = '';
  let curRow = 0;
  let curCol = 0;
  let curFg: Color = { ...DEFAULT_COLOR };
  let curBg: Color = { ...DEFAULT_COLOR };
  let curAttrs = 0;

  for (let r = 0; r < grid.height; r++) {
    if (r > 0) {
      // Reset style before row separator so the space and \x1b[2K erase use
      // the default background, not whatever the previous row left active.
      if (curAttrs !== 0 || curFg.mode !== ColorMode.Default || curBg.mode !== ColorMode.Default) {
        out += `${ESC}0m`;
        curFg = { ...DEFAULT_COLOR };
        curBg = { ...DEFAULT_COLOR };
        curAttrs = 0;
      }
      // Pending-wrap resolution: space wraps to next row, backspace to col 0.
      out += ' \x08';
      curRow = r;
      curCol = 0;
    }

    // Erase entire line to clear any stale content (and the separator space)
    out += `${ESC}2K`;

    for (let c = 0; c < grid.width; c++) {
      const cell = grid.cells[r][c];

      if (cell.width === 0) continue;

      if (!styleMatches(cell.fg, cell.bg, cell.attrs, curFg, curBg, curAttrs)) {
        out += styleDelta(curFg, curBg, curAttrs, cell.fg, cell.bg, cell.attrs);
        curFg = cell.fg;
        curBg = cell.bg;
        curAttrs = cell.attrs;
      }

      out += cell.char;
      curCol += cell.width;
    }
  }

  if (out.length > 0 && (curAttrs !== 0 || curFg.mode !== ColorMode.Default || curBg.mode !== ColorMode.Default)) {
    out += `${ESC}0m`;
  }

  return { output: out, endRow: curRow, endCol: curCol };
}

/**
 * Emit rows startRow through endRow-1 from grid using pending-wrap row
 * advancement (space+backspace). ALL rows in the range are emitted
 * unconditionally (including blank rows) so terminal content is correct
 * before those rows scroll into scrollback. No cursor preamble.
 *
 * Returns { output, endRow, endCol } where endRow/endCol are relative to
 * the range (endRow = rows emitted - 1, endCol = cursor col after last row).
 */
export function serializeRowRange(grid: CellGrid, startRow: number, endRow: number): DiffResult {
  let out = '';
  let curRow = 0;
  let curCol = 0;
  let curFg: Color = { ...DEFAULT_COLOR };
  let curBg: Color = { ...DEFAULT_COLOR };
  let curAttrs = 0;

  for (let r = startRow; r < endRow; r++) {
    const relRow = r - startRow;
    if (relRow > 0) {
      out += ' \x08';
      curRow = relRow;
      curCol = 0;
    }

    for (let c = 0; c < grid.width; c++) {
      const cell = grid.cells[r][c];
      if (cell.width === 0) continue;

      if (!styleMatches(cell.fg, cell.bg, cell.attrs, curFg, curBg, curAttrs)) {
        out += styleDelta(curFg, curBg, curAttrs, cell.fg, cell.bg, cell.attrs);
        curFg = cell.fg;
        curBg = cell.bg;
        curAttrs = cell.attrs;
      }

      out += cell.char;
      curCol += cell.width;
    }
  }

  if (out.length > 0 && (curAttrs !== 0 || curFg.mode !== ColorMode.Default || curBg.mode !== ColorMode.Default)) {
    out += `${ESC}0m`;
  }

  return { output: out, endRow: curRow, endCol: curCol };
}

/**
 * Create a viewport-sized CellGrid by copying rows scrollOffset through
 * scrollOffset+viewportRows-1 from fullGrid. Rows beyond fullGrid.height
 * are filled with blank cells.
 */
export function extractViewport(fullGrid: CellGrid, scrollOffset: number, viewportRows: number, perf?: Perf): CellGrid {
  if (perf) {
    perf.timeStart('extractViewport');
    perf.count('extractViewportCalls');
  }
  const result = createGrid(fullGrid.width, viewportRows, perf);
  let rowsCopied = 0;
  for (let r = 0; r < viewportRows; r++) {
    const srcRow = scrollOffset + r;
    if (srcRow < fullGrid.height) {
      rowsCopied++;
      for (let c = 0; c < fullGrid.width; c++) {
        const src = fullGrid.cells[srcRow][c];
        result.cells[r][c] = {
          char: src.char,
          width: src.width,
          fg: { mode: src.fg.mode, value: src.fg.value },
          bg: { mode: src.bg.mode, value: src.bg.value },
          attrs: src.attrs,
        };
      }
    }
    // else: already blank from createGrid
  }
  if (perf) {
    perf.count('extractViewportRowsCopied', rowsCopied);
    perf.count('extractViewportCellsCopied', rowsCopied * fullGrid.width);
    perf.count('extractViewportBlankRows', viewportRows - rowsCopied);
    perf.timeEnd('extractViewport');
  }
  return result;
}

// --- Row-level damage tracking helpers ---

/** Returns true if every cell in the row matches between prev and next. */
function rowsEqual(prev: CellGrid, next: CellGrid, row: number, width: number): boolean {
  for (let c = 0; c < width; c++) {
    if (!cellsEqual(prev.cells[row][c], next.cells[row][c])) return false;
  }
  return true;
}

/** Returns true if every cell in the row is default (blank, no style). */
function isBlankRow(grid: CellGrid, row: number, width: number): boolean {
  for (let c = 0; c < width; c++) {
    const cell = grid.cells[row][c];
    if (
      cell.char !== ' ' ||
      cell.width !== 1 ||
      cell.fg.mode !== ColorMode.Default ||
      cell.bg.mode !== ColorMode.Default ||
      cell.attrs !== 0
    ) return false;
  }
  return true;
}

/** Returns the index of the rightmost non-default cell in a row, or -1 if entirely blank. */
function lastContentCol(grid: CellGrid, row: number): number {
  for (let c = grid.width - 1; c >= 0; c--) {
    const cell = grid.cells[row][c];
    if (
      cell.char !== ' ' ||
      cell.width !== 1 ||
      cell.fg.mode !== ColorMode.Default ||
      cell.bg.mode !== ColorMode.Default ||
      cell.attrs !== 0
    ) return c;
  }
  return -1;
}

/** Returns true if every cell from startCol to width-1 is default (blank, no style). */
function isBlankFrom(grid: CellGrid, row: number, startCol: number, width: number): boolean {
  for (let c = startCol; c < width; c++) {
    const cell = grid.cells[row][c];
    if (
      cell.char !== ' ' ||
      cell.width !== 1 ||
      cell.fg.mode !== ColorMode.Default ||
      cell.bg.mode !== ColorMode.Default ||
      cell.attrs !== 0
    ) return false;
  }
  return true;
}

/**
 * Diff two CellGrids and return minimal ANSI escape sequences to transform
 * prev into next. Uses only relative cursor movements (CUU/CUD/CHA),
 * no absolute CUP (\x1b[r;cH), so it works in inline terminal mode.
 * Grids must have the same dimensions.
 *
 * `startRow`/`startCol` specify where the real terminal cursor currently is
 * (relative to the owned region). Defaults to prev's cursor position for
 * backward compatibility, but callers should pass the actual position.
 */
export function diff(
  prev: CellGrid,
  next: CellGrid,
  startRow?: number,
  startCol?: number,
  perf?: Perf,
): DiffResult {
  if (perf) {
    perf.count('diffCalls');
    perf.timeStart('diff');
  }

  if (prev.width !== next.width || prev.height !== next.height) {
    if (perf) {
      perf.count('diffFullRedrawFallbacks');
      perf.timeEnd('diff');
    }
    return fullRedraw(next);
  }

  const width = next.width;
  const height = next.height;
  let out = "";
  let skippedRows = 0;
  let erasedRows = 0;
  let erasedTrailing = 0;
  let changedCells = 0;
  let cursorMoves = 0;
  let styleDeltas = 0;

  // Cursor starts where the caller says it is
  let curRow = startRow ?? prev.cursorRow;
  let curCol = startCol ?? prev.cursorCol;
  let curFg: Color = { ...DEFAULT_COLOR };
  let curBg: Color = { ...DEFAULT_COLOR };
  let curAttrs = 0;
  let styleKnown = false;

  for (let r = 0; r < height; r++) {
    // Check 1: Skip unchanged rows entirely. Avoids all cell comparisons for
    // the common case where most rows don't change between frames.
    if (rowsEqual(prev, next, r, width)) { skippedRows++; continue; }

    // Check 2: Entire next row is blank but prev had content; bulk erase line.
    if (isBlankRow(next, r, width)) {
      if (curRow !== r || curCol !== 0) {
        out += moveCursor(curRow, curCol, r, 0);
        cursorMoves++;
        curRow = r;
        curCol = 0;
      }
      // Ensure default bg so \x1b[2K erases with terminal default, not active bg.
      if (!styleKnown || curBg.mode !== ColorMode.Default) {
        out += `${ESC}0m`;
        curFg = { ...DEFAULT_COLOR };
        curBg = { ...DEFAULT_COLOR };
        curAttrs = 0;
      }
      styleKnown = true;
      out += `${ESC}2K`;
      // curCol stays at 0; EL doesn't move cursor
      erasedRows++;
      continue;
    }

    for (let c = 0; c < width; c++) {
      const pCell = prev.cells[r][c];
      const nCell = next.cells[r][c];

      // Skip wide-char continuation cells in the next grid
      if (nCell.width === 0) continue;

      if (cellsEqual(pCell, nCell)) {
        // If this is a wide char, its continuation must also match
        if (nCell.width > 1 && c + 1 < width) {
          if (cellsEqual(prev.cells[r][c + 1], next.cells[r][c + 1])) {
            continue;
          }
          // Continuation changed, need to rewrite the wide char
        } else {
          continue;
        }
      }

      // Check 3: Changed cell is blank and all remaining cells are blank.
      // erase to end of line instead of writing individual blank cells.
      if (
        nCell.char === ' ' &&
        nCell.width === 1 &&
        nCell.fg.mode === ColorMode.Default &&
        nCell.bg.mode === ColorMode.Default &&
        nCell.attrs === 0 &&
        isBlankFrom(next, r, c, width)
      ) {
        if (curRow !== r || curCol !== c) {
          out += moveCursor(curRow, curCol, r, c);
          cursorMoves++;
          curRow = r;
          curCol = c;
        }
        // Ensure default bg so \x1b[0K erases with terminal default, not active bg.
        if (!styleKnown || curBg.mode !== ColorMode.Default) {
          out += `${ESC}0m`;
          curFg = { ...DEFAULT_COLOR };
          curBg = { ...DEFAULT_COLOR };
          curAttrs = 0;
        }
        styleKnown = true;
        out += `${ESC}0K`;
        erasedTrailing++;
        break; // rest of row handled
      }

      // Position cursor using relative movement
      if (curRow !== r || curCol !== c) {
        out += moveCursor(curRow, curCol, r, c);
        cursorMoves++;
        curRow = r;
        curCol = c;
      }

      // Set style if needed
      if (!styleKnown) {
        // First cell: unknown terminal state, must do full emit
        styleDeltas++;
        out += `${ESC}0m`;
        if (
          nCell.attrs !== 0 ||
          nCell.fg.mode !== ColorMode.Default ||
          nCell.bg.mode !== ColorMode.Default
        ) {
          out += styleToAnsi(nCell.fg, nCell.bg, nCell.attrs);
        }
        curFg = nCell.fg;
        curBg = nCell.bg;
        curAttrs = nCell.attrs;
        styleKnown = true;
      } else if (!styleMatches(nCell.fg, nCell.bg, nCell.attrs, curFg, curBg, curAttrs)) {
        styleDeltas++;
        out += styleDelta(curFg, curBg, curAttrs, nCell.fg, nCell.bg, nCell.attrs);
        curFg = nCell.fg;
        curBg = nCell.bg;
        curAttrs = nCell.attrs;
      }

      // Write the character
      changedCells++;
      out += nCell.char;
      curCol += nCell.width;

      // If prev had a wide char here but next has a narrow char,
      // clear the orphaned continuation cell
      if (
        nCell.width === 1 &&
        c + 1 < width &&
        pCell.width === 2
      ) {
        out += " ";
        curCol++;
      }
    }
  }

  if (out.length > 0 && styleKnown && (curAttrs !== 0 || curFg.mode !== ColorMode.Default || curBg.mode !== ColorMode.Default)) {
    out += `${ESC}0m`;
  }

  if (perf) {
    perf.count('diffRowsCompared', height);
    perf.count('diffRowsSkipped', skippedRows);
    perf.count('diffRowsErased', erasedRows);
    perf.count('diffTrailingEraseHits', erasedTrailing);
    perf.count('diffChangedCells', changedCells);
    perf.count('diffCursorMoves', cursorMoves);
    perf.count('diffStyleDeltas', styleDeltas);
    perf.timeEnd('diff');
  }

  return { output: out, endRow: curRow, endCol: curCol };
}
