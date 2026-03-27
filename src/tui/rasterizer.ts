/** Paints the laid-out TNode tree into a CellGrid. */
import { createGrid, ColorMode, Attr, type CellGrid, type Color } from '../cell.js';
import type { TNode, SegmentStyle } from './nodes.js';
import { charDisplayWidth, stringDisplayWidth, isTextPresentationEmoji, isSkinToneModifier, isRegionalIndicator } from '../width.js';

interface BorderChars {
  tl: string; tr: string; bl: string; br: string; h: string; v: string;
}

const BORDER_STYLES: Record<string, BorderChars> = {
  single: { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' },
  double: { tl: '╔', tr: '╗', bl: '╚', br: '╝', h: '═', v: '║' },
  round:  { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' },
  bold:   { tl: '┏', tr: '┓', bl: '┗', br: '┛', h: '━', v: '┃' },
};

interface StyleContext {
  fg?: Color;
  bg?: Color;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  inverse?: boolean;
}

const NAMED_COLORS: Record<string, number> = {
  red: 0xff0000,
  green: 0x00ff00,
  blue: 0x0000ff,
  yellow: 0xffff00,
  cyan: 0x00ffff,
  magenta: 0xff00ff,
  white: 0xffffff,
  gray: 0x808080,
};

function parseColor(value: unknown): Color | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') {
    if (value.startsWith('#') && (value.length === 7 || value.length === 9)) {
      // Parse #RRGGBB or #RRGGBBAA (alpha ignored for terminal output)
      const n = parseInt(value.slice(1, 7), 16);
      if (!isNaN(n)) return { mode: ColorMode.RGB, value: n };
    }
    const named = NAMED_COLORS[value.toLowerCase()];
    if (named !== undefined) return { mode: ColorMode.RGB, value: named };
  }
  return undefined;
}

function mergeStyle(inherited: StyleContext, props: Record<string, any>): StyleContext {
  const ctx: StyleContext = { ...inherited };
  const fg = parseColor(props.fg) ?? parseColor(props.color);
  if (fg) ctx.fg = fg;
  const bg = parseColor(props.backgroundColor);
  if (bg) ctx.bg = bg;
  if (props.bold != null) ctx.bold = props.bold;
  if (props.dim != null) ctx.dim = props.dim;
  if (props.italic != null) ctx.italic = props.italic;
  if (props.underline != null) ctx.underline = props.underline;
  if (props.strikethrough != null) ctx.strikethrough = props.strikethrough;
  if (props.inverse != null) ctx.inverse = props.inverse;
  return ctx;
}

/** Merge a SegmentStyle on top of an existing StyleContext. Segment wins. */
function mergeSegmentStyle(base: StyleContext, seg: SegmentStyle): StyleContext {
  const ctx: StyleContext = { ...base };
  const fg = parseColor(seg.color) ?? parseColor(seg.fg);
  if (fg) ctx.fg = fg;
  const bg = parseColor(seg.backgroundColor);
  if (bg) ctx.bg = bg;
  if (seg.bold != null) ctx.bold = seg.bold;
  if (seg.dim != null) ctx.dim = seg.dim;
  if (seg.italic != null) ctx.italic = seg.italic;
  if (seg.underline != null) ctx.underline = seg.underline;
  if (seg.strikethrough != null) ctx.strikethrough = seg.strikethrough;
  if (seg.inverse != null) ctx.inverse = seg.inverse;
  return ctx;
}

function styleAttrs(ctx: StyleContext): number {
  let a = 0;
  if (ctx.bold) a |= Attr.Bold;
  if (ctx.dim) a |= Attr.Dim;
  if (ctx.italic) a |= Attr.Italic;
  if (ctx.underline) a |= Attr.Underline;
  if (ctx.strikethrough) a |= Attr.Strikethrough;
  if (ctx.inverse) a |= Attr.Inverse;
  return a;
}

export function rasterize(
  root: TNode,
  width: number,
  height: number,
  scrollOffset: number = 0,
): CellGrid {
  const grid = createGrid(width, height);
  walkNode(root, {}, grid, scrollOffset, false);
  return grid;
}

function walkNode(
  node: TNode,
  inherited: StyleContext,
  grid: CellGrid,
  scrollOffset: number,
  skipScrollOffset: boolean,
): void {
  if (!node.layout) return;
  if (node.props.display === 'none') return;

  const l = node.layout;

  const effectiveOffset = skipScrollOffset ? 0 : scrollOffset;

  // Skip nodes entirely above or below the viewport
  // (root node is always processed — its y=0 and height=contentHeight)
  if (node.type !== 'root') {
    if (l.y + l.height <= effectiveOffset) return; // entirely above
    if (l.y - effectiveOffset >= grid.height) return; // entirely below
  }

  const style = mergeStyle(inherited, node.props);

  if (node.type === 'text') {
    rasterizeText(node, style, grid, effectiveOffset);
    return;
  }

  if (node.type === 'divider') {
    const row = l.y - effectiveOffset;
    if (row < 0 || row >= grid.height) return;
    const char = (node.props.char as string) ?? '─';
    const fg = parseColor(node.props.color) ?? style.fg;
    const attrs = styleAttrs(style);
    for (let c = l.x; c < l.x + l.width && c < grid.width; c++) {
      const cell = grid.cells[row]![c]!;
      cell.char = char;
      cell.width = 1;
      if (fg) cell.fg = { ...fg };
      cell.attrs = attrs;
    }
    return;
  }

  // Box or root: fill background if set, draw border, then recurse children
  if (node.props.backgroundColor) {
    fillBackground(node, parseColor(node.props.backgroundColor)!, grid, effectiveOffset);
  }

  if (node.props.borderStyle) {
    drawBorder(node, style, grid, effectiveOffset);
  }

  for (const child of node.children) {
    walkNode(child, style, grid, scrollOffset, skipScrollOffset);
  }
}

function drawBorder(
  node: TNode,
  style: StyleContext,
  grid: CellGrid,
  scrollOffset: number,
): void {
  const l = node.layout!;
  const chars = BORDER_STYLES[node.props.borderStyle as string];
  if (!chars) return;

  const fg = parseColor(node.props.borderColor) ?? style.fg;
  const bg = style.bg ?? parseColor(node.props.backgroundColor);

  const topRow = l.y - scrollOffset;
  const bottomRow = l.y + l.height - 1 - scrollOffset;
  const leftCol = l.x;
  const rightCol = l.x + l.width - 1;

  function setCell(row: number, col: number, ch: string): void {
    if (row < 0 || row >= grid.height || col < 0 || col >= grid.width) return;
    const cell = grid.cells[row]![col]!;
    cell.char = ch;
    cell.width = 1;
    if (fg) cell.fg = { ...fg };
    if (bg) cell.bg = { ...bg };
  }

  // Top edge
  if (topRow >= 0 && topRow < grid.height) {
    setCell(topRow, leftCol, chars.tl);
    for (let c = leftCol + 1; c < rightCol; c++) {
      setCell(topRow, c, chars.h);
    }
    setCell(topRow, rightCol, chars.tr);
  }

  // Bottom edge
  if (bottomRow >= 0 && bottomRow < grid.height) {
    setCell(bottomRow, leftCol, chars.bl);
    for (let c = leftCol + 1; c < rightCol; c++) {
      setCell(bottomRow, c, chars.h);
    }
    setCell(bottomRow, rightCol, chars.br);
  }

  // Left and right edges (between top and bottom)
  for (let r = topRow + 1; r < bottomRow; r++) {
    if (r < 0 || r >= grid.height) continue;
    setCell(r, leftCol, chars.v);
    setCell(r, rightCol, chars.v);
  }
}

function fillBackground(
  node: TNode,
  bg: Color,
  grid: CellGrid,
  scrollOffset: number,
): void {
  const l = node.layout!;
  const startRow = Math.max(l.y - scrollOffset, 0);
  const endRow = Math.min(l.y + l.height - scrollOffset, grid.height);

  for (let row = startRow; row < endRow; row++) {
    for (let col = l.x; col < l.x + l.width; col++) {
      if (col >= grid.width) break;
      grid.cells[row]![col]!.bg = { ...bg };
    }
  }
}

function rasterizeText(
  node: TNode,
  style: StyleContext,
  grid: CellGrid,
  scrollOffset: number,
): void {
  const l = node.layout!;
  const lines = l.wrappedLines;
  if (!lines || lines.length === 0) return;

  const bg = style.bg ?? parseColor(node.props.backgroundColor);

  // Fill background for the entire text rect if bg is set (clipped to viewport)
  if (bg) {
    const startRow = Math.max(l.y - scrollOffset, 0);
    const endRow = Math.min(l.y + l.height - scrollOffset, grid.height);
    for (let row = startRow; row < endRow; row++) {
      for (let col = l.x; col < l.x + l.width; col++) {
        if (col >= grid.width) break;
        grid.cells[row]![col]!.bg = { ...bg };
      }
    }
  }

  const hangingIndent = l.hangingIndent ?? 0;

  // Compute how many lines to skip due to clipping above viewport
  const clippedLines = Math.max(scrollOffset - l.y, 0);

  const textAlign = l.textAlign;

  for (let i = clippedLines; i < lines.length; i++) {
    const row = l.y + i - scrollOffset;
    if (row >= grid.height) break;
    if (row < 0) continue; // safety
    const xBase = i === 0 ? l.x : l.x + hangingIndent;
    const line = lines[i]!; // WrappedLine = StyledRun[]

    // Compute per-line alignment offset
    let xStart = xBase;
    if (textAlign === 'center' || textAlign === 'right') {
      let lineLen = 0;
      for (const run of line) lineLen += stringDisplayWidth(run.text);
      const slack = l.width - lineLen - (i === 0 ? 0 : hangingIndent);
      if (slack > 0) {
        xStart += textAlign === 'center' ? Math.floor(slack / 2) : slack;
      }
    }

    let col = xStart;
    let prevCell: typeof grid.cells[0][0] | null = null;
    for (const run of line) {
      const runStyle = run.style ? mergeSegmentStyle(style, run.style) : style;
      const runFg = runStyle.fg;
      const runAttrs = styleAttrs(runStyle);

      let prevWasZWJ = false;
      let prevWasRI = false;
      for (const ch of run.text) {
        const cp = ch.codePointAt(0)!;
        let w = charDisplayWidth(cp);

        // Grapheme cluster awareness: skin tone, ZWJ sequences, regional indicator pairs
        let clusterAppend = false;
        if (w === 2 && prevCell) {
          if (isSkinToneModifier(cp) && prevCell.width === 2) {
            clusterAppend = true;
          } else if (isRegionalIndicator(cp) && prevWasRI) {
            clusterAppend = true;
          } else if (prevWasZWJ) {
            clusterAppend = true;
          }
        }

        if (clusterAppend) {
          prevCell!.char += ch;
          prevWasZWJ = false;
          prevWasRI = false;
          continue;
        }

        if (w === 0) {
          // Combining mark / ZWJ / variation selector: attach to previous cell
          if (prevCell) {
            prevCell.char += ch;
            // VS16 (U+FE0F) upgrades text-presentation emoji to width 2
            if (cp === 0xfe0f && prevCell.width === 1 && col < grid.width) {
              const baseCp = prevCell.char.codePointAt(0);
              if (baseCp !== undefined && isTextPresentationEmoji(baseCp)) {
                prevCell.width = 2;
                // Current col becomes continuation cell
                const cont = grid.cells[row]![col]!;
                cont.char = '';
                cont.width = 0;
                cont.attrs = runAttrs;
                if (runFg) cont.fg = { ...runFg };
                if (bg) cont.bg = { ...bg };
                col++;
              }
            }
          }
          prevWasZWJ = cp === 0x200d;
          prevWasRI = false;
          continue;
        }

        if (w === 2 && col + 2 > grid.width) break; // wide char won't fit
        if (col >= grid.width) break;

        const cell = grid.cells[row]![col]!;
        cell.char = ch;
        cell.width = w;
        cell.attrs = runAttrs;
        if (runFg) cell.fg = { ...runFg };
        if (bg) cell.bg = { ...bg };
        prevCell = cell;

        if (w === 2) {
          // Write continuation cell
          const cont = grid.cells[row]![col + 1]!;
          cont.char = '';
          cont.width = 0;
          cont.attrs = runAttrs;
          if (runFg) cont.fg = { ...runFg };
          if (bg) cont.bg = { ...bg };
        }

        col += w;
        prevWasZWJ = false;
        prevWasRI = isRegionalIndicator(cp);
      }
    }
  }
}
