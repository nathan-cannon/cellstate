/**
 * Packed-buffer rasterizer. Walks the laid-out TNode tree and writes cells
 * into a CellBuffer using interning tables, replacing the object-heavy
 * CellGrid rasterizer.
 */
import { ColorMode, Attr } from './cell.js';
import type { TNode, SegmentStyle } from './nodes.js';
import { charDisplayWidth, stringDisplayWidth, isTextPresentationEmoji, isSkinToneModifier, isRegionalIndicator } from './width.js';
import { type CharTable, EMPTY_CHAR } from './char-table.js';
import { type StyleTable, DEFAULT_STYLE } from './style-table.js';
import { type LinkTable, NO_LINK } from './link-table.js';
import {
  type CellBuffer,
  writeCell,
  blitRegion,
  clearRegion,
  NORMAL_WIDTH,
  WIDE_WIDTH,
  CONTINUATION_WIDTH,
} from './cell-buffer.js';
import { propagateDirty, clearAllDirty } from './dirty.js';
import type { Perf } from './perf.js';

// --- Color parsing (ported from rasterizer.ts) ---

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

function parseColorToModeValue(value: unknown): { mode: number; value: number } | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') {
    if (value.startsWith('#') && (value.length === 7 || value.length === 9)) {
      const n = parseInt(value.slice(1, 7), 16);
      if (!isNaN(n)) return { mode: ColorMode.RGB, value: n };
    }
    const named = NAMED_COLORS[value.toLowerCase()];
    if (named !== undefined) return { mode: ColorMode.RGB, value: named };
  }
  return undefined;
}

// --- Border styles (duplicated from rasterizer.ts) ---

interface BorderChars {
  tl: string; tr: string; bl: string; br: string; h: string; v: string;
}

const BORDER_STYLES: Record<string, BorderChars> = {
  single: { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' },
  double: { tl: '╔', tr: '╗', bl: '╚', br: '╝', h: '═', v: '║' },
  round:  { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' },
  bold:   { tl: '┏', tr: '┓', bl: '┗', br: '┛', h: '━', v: '┃' },
};

// --- Resolved style ---

interface ResolvedStyle {
  attrs: number;
  fgMode: number;
  fgValue: number;
  bgMode: number;
  bgValue: number;
  styleId: number;
}

const DEFAULT_RESOLVED: ResolvedStyle = {
  attrs: 0,
  fgMode: ColorMode.Default,
  fgValue: 0,
  bgMode: ColorMode.Default,
  bgValue: 0,
  styleId: DEFAULT_STYLE,
};

function resolveStyle(
  inherited: ResolvedStyle,
  props: Record<string, any>,
  styleTable: StyleTable,
): ResolvedStyle {
  let { attrs, fgMode, fgValue, bgMode, bgValue } = inherited;

  const fg = parseColorToModeValue(props.fg) ?? parseColorToModeValue(props.color);
  if (fg) { fgMode = fg.mode; fgValue = fg.value; }

  const bg = parseColorToModeValue(props.backgroundColor);
  if (bg) { bgMode = bg.mode; bgValue = bg.value; }

  if (props.bold != null) attrs = props.bold ? (attrs | Attr.Bold) : (attrs & ~Attr.Bold);
  if (props.dim != null) attrs = props.dim ? (attrs | Attr.Dim) : (attrs & ~Attr.Dim);
  if (props.italic != null) attrs = props.italic ? (attrs | Attr.Italic) : (attrs & ~Attr.Italic);
  if (props.underline != null) attrs = props.underline ? (attrs | Attr.Underline) : (attrs & ~Attr.Underline);
  if (props.strikethrough != null) attrs = props.strikethrough ? (attrs | Attr.Strikethrough) : (attrs & ~Attr.Strikethrough);
  if (props.inverse != null) attrs = props.inverse ? (attrs | Attr.Inverse) : (attrs & ~Attr.Inverse);

  const styleId = styleTable.intern(attrs, fgMode, fgValue, bgMode, bgValue);
  return { attrs, fgMode, fgValue, bgMode, bgValue, styleId };
}

function resolveSegmentStyle(
  base: ResolvedStyle,
  seg: SegmentStyle,
  styleTable: StyleTable,
): ResolvedStyle {
  let { attrs, fgMode, fgValue, bgMode, bgValue } = base;

  const fg = parseColorToModeValue(seg.color) ?? parseColorToModeValue(seg.fg);
  if (fg) { fgMode = fg.mode; fgValue = fg.value; }

  const bg = parseColorToModeValue(seg.backgroundColor);
  if (bg) { bgMode = bg.mode; bgValue = bg.value; }

  if (seg.bold != null) attrs = seg.bold ? (attrs | Attr.Bold) : (attrs & ~Attr.Bold);
  if (seg.dim != null) attrs = seg.dim ? (attrs | Attr.Dim) : (attrs & ~Attr.Dim);
  if (seg.italic != null) attrs = seg.italic ? (attrs | Attr.Italic) : (attrs & ~Attr.Italic);
  if (seg.underline != null) attrs = seg.underline ? (attrs | Attr.Underline) : (attrs & ~Attr.Underline);
  if (seg.strikethrough != null) attrs = seg.strikethrough ? (attrs | Attr.Strikethrough) : (attrs & ~Attr.Strikethrough);
  if (seg.inverse != null) attrs = seg.inverse ? (attrs | Attr.Inverse) : (attrs & ~Attr.Inverse);

  const styleId = styleTable.intern(attrs, fgMode, fgValue, bgMode, bgValue);
  return { attrs, fgMode, fgValue, bgMode, bgValue, styleId };
}

// --- Main paint function ---

/** Clear the part of an old rect that the new rect doesn't cover. */
function clearRectDifference(
  buf: CellBuffer,
  ox: number, oy: number, ow: number, oh: number,
  nx: number, ny: number, nw: number, nh: number,
): void {
  if (ow <= 0 || oh <= 0) return;
  // No overlap → clear the entire old rect.
  if (nx >= ox + ow || nx + nw <= ox || ny >= oy + oh || ny + nh <= oy) {
    clearRegion(buf, ox, oy, ow, oh);
    return;
  }
  // Top strip.
  if (oy < ny) clearRegion(buf, ox, oy, ow, ny - oy);
  // Bottom strip.
  if (oy + oh > ny + nh) clearRegion(buf, ox, ny + nh, ow, (oy + oh) - (ny + nh));
  // Middle band y-range.
  const midY = Math.max(oy, ny);
  const midH = Math.min(oy + oh, ny + nh) - midY;
  if (midH > 0) {
    if (ox < nx) clearRegion(buf, ox, midY, nx - ox, midH);
    if (ox + ow > nx + nw) clearRegion(buf, nx + nw, midY, (ox + ow) - (nx + nw), midH);
  }
}

let movementDetected = false;

export function paintTree(
  root: TNode,
  buffer: CellBuffer,
  frontBuffer: CellBuffer | null,
  charTable: CharTable,
  styleTable: StyleTable,
  linkTable: LinkTable,
  scrollOffset: number = 0,
  perf?: Perf,
): void {
  movementDetected = false;
  // Pass 1 — clears only. Walks the tree, clears the rect-difference of any
  // moved/resized node and processes _pendingClears from removed subtrees.
  // Updates _prevBounds and propagates dirty for movement. NO painting.
  walkClears(root, buffer, scrollOffset, 0, 0);
  // Pass 2 — paint. With all clears already applied to the back buffer, no
  // child can clobber a parent's painted content (e.g. a border row).
  walkNode(root, DEFAULT_RESOLVED, buffer, frontBuffer, charTable, styleTable, linkTable, scrollOffset, false, perf, 0, 0);
  if (movementDetected && perf) {
    perf.count('layoutMovementFrames');
  }
  clearAllDirty(root);
}

function walkClears(
  node: TNode,
  buffer: CellBuffer,
  scrollOffset: number,
  parentAbsX: number,
  parentAbsY: number,
): void {
  const fn = node.flexNode;
  if (!fn) return; // legacy/test path has no Yoga state — pass 1 is a no-op
  if (node.props.display === 'none') return;

  const absX = parentAbsX + fn.getComputedLeft();
  const absY = parentAbsY + fn.getComputedTop();
  const w = fn.getComputedWidth();
  const h = fn.getComputedHeight();

  const prev = node._prevBounds;
  let boundsMatch = false;
  if (prev) {
    boundsMatch = prev.x === absX && prev.y === absY && prev.width === w && prev.height === h;
    if (!boundsMatch) {
      movementDetected = true;
      propagateDirty(node);
      clearRectDifference(buffer, prev.x, prev.y - scrollOffset, prev.width, prev.height,
        absX, absY - scrollOffset, w, h);
    }
  }
  if (!boundsMatch) {
    node._prevBounds = { x: absX, y: absY, width: w, height: h };
  }

  if (node._pendingClears && node._pendingClears.length > 0) {
    for (const rect of node._pendingClears) {
      clearRegion(buffer, rect.x, rect.y - scrollOffset, rect.width, rect.height);
    }
    node._pendingClears = undefined;
  }

  // Skip clean subtrees: if no React changes (_dirty=false), no detached
  // children, and bounds matched, neither this node nor any descendant has
  // moved or needs clearing. Dirty bubbles up via reconciler+propagateDirty,
  // so a clean ancestor implies a clean subtree.
  if (boundsMatch && !node._dirty && !node._childWasDetached) return;

  for (const child of node.children) {
    walkClears(child, buffer, scrollOffset, absX, absY);
  }
}

function walkNode(
  node: TNode,
  inherited: ResolvedStyle,
  buffer: CellBuffer,
  frontBuffer: CellBuffer | null,
  charTable: CharTable,
  styleTable: StyleTable,
  linkTable: LinkTable,
  scrollOffset: number,
  skipScrollOffset: boolean,
  perf: Perf | undefined,
  parentAbsX: number,
  parentAbsY: number,
): void {
  const fn = node.flexNode;
  if (!fn && !node.layout) return;
  if (node.props.display === 'none') return;

  let absX: number, absY: number, w: number, h: number;

  if (fn) {
    // --- Yoga path: pass 1 has already updated _prevBounds with current
    // absolute position+size and propagated dirty for any movement. Just
    // read it back. ---
    const prev = node._prevBounds!;
    absX = prev.x;
    absY = prev.y;
    w = prev.width;
    h = prev.height;
  } else {
    // --- Legacy path: layout pre-set externally (unit tests) ---
    const l = node.layout!;
    absX = l.x;
    absY = l.y;
    w = l.width;
    h = l.height;
  }

  const effectiveOffset = skipScrollOffset ? 0 : scrollOffset;

  // --- Viewport culling ---
  if (node.type !== 'root') {
    if (absY + h <= effectiveOffset) return;
    if (absY - effectiveOffset >= buffer.height) return;
  }

  // --- Blit check: skip subtree if clean ---
  // Pass 1 propagates dirty for movement, so !_dirty implies bounds unchanged
  // AND no descendant changed AND no descendant moved.
  if (fn && !node._dirty && !node._childWasDetached && frontBuffer) {
    blitRegion(frontBuffer, buffer, absY, absX, absY, absX, h, w);
    if (perf) {
      perf.count('subtreeBlits');
      perf.count('subtreeBlitCells', w * h);
    }
    return;
  }

  // --- Populate node.layout from Yoga (skip for legacy path — already set) ---
  if (fn) {
    if (node.type === 'text') {
      const cache = node._wrapCache;
      let textAlign: 'left' | 'center' | 'right' | undefined;
      // alignItems acts on the cross-axis. Yoga already positions this node
      // along the cross axis — we only need a per-line text offset when the
      // cross axis is horizontal, i.e. flexDirection: 'row'.
      const parentFlexDirection = (node.parent?.props.flexDirection as string | undefined) ?? 'column';
      if (parentFlexDirection === 'row') {
        const parentAlign = node.parent?.props.alignItems as string | undefined;
        if (parentAlign === 'center') textAlign = 'center';
        else if (parentAlign === 'flex-end') textAlign = 'right';
      }
      node.layout = {
        x: absX, y: absY, width: w, height: h,
        wrappedLines: cache?.wrappedLines ?? [],
        hangingIndent: cache?.hangingIndent,
        textAlign,
      };
    } else {
      node.layout = { x: absX, y: absY, width: w, height: h };
    }
  }

  if (perf) {
    perf.count('subtreesPainted');
    switch (node.type) {
      case 'root': perf.count('walkNodeRoot'); break;
      case 'box': perf.count('walkNodeBox'); break;
      case 'text': perf.count('walkNodeText'); break;
      case 'divider': perf.count('walkNodeDivider'); break;
      case 'raw-ansi': perf.count('walkNodeRawAnsi'); break;
    }
  }

  const style = resolveStyle(inherited, node.props, styleTable);

  if (node.type === 'raw-ansi') {
    paintRawAnsi(node, inherited, buffer, charTable, styleTable, linkTable, effectiveOffset, perf);
    return;
  }

  if (node.type === 'text') {
    paintText(node, style, buffer, charTable, styleTable, linkTable, effectiveOffset, perf);
    return;
  }

  if (node.type === 'divider') {
    const row = absY - effectiveOffset;
    if (row < 0 || row >= buffer.height) return;
    const ch = (node.props.char as string) ?? '─';
    const divColor = parseColorToModeValue(node.props.color);
    let divStyle: ResolvedStyle;
    if (divColor) {
      divStyle = {
        ...style,
        fgMode: divColor.mode,
        fgValue: divColor.value,
        styleId: styleTable.intern(style.attrs, divColor.mode, divColor.value, style.bgMode, style.bgValue),
      };
    } else {
      divStyle = style;
    }
    const charId = charTable.intern(ch);
    for (let c = absX; c < absX + w && c < buffer.width; c++) {
      writeCell(buffer, row, c, charId, divStyle.styleId, NO_LINK, NORMAL_WIDTH);
    }
    return;
  }

  // Box or root: fill background if set, draw border, then recurse children
  if (node.props.backgroundColor) {
    const bg = parseColorToModeValue(node.props.backgroundColor);
    if (bg) {
      paintBackground(node, bg, style, buffer, styleTable, effectiveOffset, perf);
    }
  }

  if (node.props.borderStyle) {
    paintBorder(node, style, buffer, charTable, styleTable, effectiveOffset, perf);
  }

  // Pass 1 already processed _pendingClears for this node. If any removal
  // happened on this parent, poison the front buffer for all children so
  // their blits don't reintroduce stale content over the cleared region.
  const childFrontBuffer = node._childWasDetached ? null : frontBuffer;

  // --- Recurse children with sibling overflow tracking ---
  let overflowTainted = false;
  for (const child of node.children) {
    const childFront = overflowTainted ? null : childFrontBuffer;

    walkNode(child, style, buffer, childFront, charTable, styleTable, linkTable, scrollOffset, skipScrollOffset, perf, absX, absY);

    // After rendering this child, check if it taints subsequent siblings.
    // Bounds changes set _dirty via propagateDirty above, so _dirty covers
    // both content changes and position changes.
    if (child._dirty) {
      if (child.props.overflow !== 'hidden' && child.props.position !== 'absolute') {
        overflowTainted = true;
        if (perf) perf.count('overflowTaintForced');
      }
    }
  }
}

function paintBackground(
  node: TNode,
  bg: { mode: number; value: number },
  style: ResolvedStyle,
  buffer: CellBuffer,
  styleTable: StyleTable,
  scrollOffset: number,
  perf?: Perf,
): void {
  if (perf) {
    perf.count('fillBackgroundCalls');
    perf.timeStart('fillBackground');
  }
  const l = node.layout!;
  const startRow = Math.max(l.y - scrollOffset, 0);
  const endRow = Math.min(l.y + l.height - scrollOffset, buffer.height);

  // Background-only style: just the bg color on default attrs/fg
  // Actually we need to preserve the char (space) and just set bg.
  // writeCell replaces the full cell, but for bg fill we want to set
  // only the bg on blank cells. We need a style with just bg.
  const bgStyleId = styleTable.intern(0, ColorMode.Default, 0, bg.mode, bg.value);

  let bgCellCount = 0;
  for (let row = startRow; row < endRow; row++) {
    for (let col = l.x; col < l.x + l.width; col++) {
      if (col >= buffer.width) break;
      // Write a space with the bg style — text will overwrite later
      writeCell(buffer, row, col, 0, bgStyleId, NO_LINK, NORMAL_WIDTH);
      bgCellCount++;
    }
  }

  if (perf) {
    perf.count('bgFillCells', bgCellCount);
    perf.timeEnd('fillBackground');
  }
}

function paintBorder(
  node: TNode,
  style: ResolvedStyle,
  buffer: CellBuffer,
  charTable: CharTable,
  styleTable: StyleTable,
  scrollOffset: number,
  perf?: Perf,
): void {
  if (perf) {
    perf.count('drawBorderCalls');
    perf.timeStart('drawBorder');
  }
  const l = node.layout!;
  const chars = BORDER_STYLES[node.props.borderStyle as string];
  if (!chars) {
    if (perf) perf.timeEnd('drawBorder');
    return;
  }

  // Border color: explicit borderColor prop, or inherited fg
  const borderColor = parseColorToModeValue(node.props.borderColor);
  const bg = parseColorToModeValue(node.props.backgroundColor);

  let borderFgMode = style.fgMode;
  let borderFgValue = style.fgValue;
  if (borderColor) {
    borderFgMode = borderColor.mode;
    borderFgValue = borderColor.value;
  }

  let borderBgMode = style.bgMode;
  let borderBgValue = style.bgValue;
  if (bg) {
    borderBgMode = bg.mode;
    borderBgValue = bg.value;
  }

  const borderStyleId = styleTable.intern(0, borderFgMode, borderFgValue, borderBgMode, borderBgValue);

  const topRow = l.y - scrollOffset;
  const bottomRow = l.y + l.height - 1 - scrollOffset;
  const leftCol = l.x;
  const rightCol = l.x + l.width - 1;

  let borderCellCount = 0;

  function setBorderCell(row: number, col: number, ch: string): void {
    if (row < 0 || row >= buffer.height || col < 0 || col >= buffer.width) return;
    const charId = charTable.intern(ch);
    writeCell(buffer, row, col, charId, borderStyleId, NO_LINK, NORMAL_WIDTH);
    borderCellCount++;
  }

  // Top edge
  if (topRow >= 0 && topRow < buffer.height) {
    setBorderCell(topRow, leftCol, chars.tl);
    for (let c = leftCol + 1; c < rightCol; c++) {
      setBorderCell(topRow, c, chars.h);
    }
    setBorderCell(topRow, rightCol, chars.tr);
  }

  // Bottom edge
  if (bottomRow >= 0 && bottomRow < buffer.height) {
    setBorderCell(bottomRow, leftCol, chars.bl);
    for (let c = leftCol + 1; c < rightCol; c++) {
      setBorderCell(bottomRow, c, chars.h);
    }
    setBorderCell(bottomRow, rightCol, chars.br);
  }

  // Left and right edges
  for (let r = topRow + 1; r < bottomRow; r++) {
    if (r < 0 || r >= buffer.height) continue;
    setBorderCell(r, leftCol, chars.v);
    setBorderCell(r, rightCol, chars.v);
  }

  if (perf) {
    perf.count('borderCells', borderCellCount);
    perf.timeEnd('drawBorder');
  }
}

function paintText(
  node: TNode,
  style: ResolvedStyle,
  buffer: CellBuffer,
  charTable: CharTable,
  styleTable: StyleTable,
  linkTable: LinkTable,
  scrollOffset: number,
  perf?: Perf,
): void {
  if (perf) {
    perf.count('rasterizeTextCalls');
    perf.timeStart('rasterizeText');
  }
  const l = node.layout!;
  const lines = l.wrappedLines;
  if (!lines || lines.length === 0) {
    if (perf) perf.timeEnd('rasterizeText');
    return;
  }

  // Fill background for the entire text rect if bg is set
  const bg = parseColorToModeValue(node.props.backgroundColor) ??
    (style.bgMode !== ColorMode.Default ? { mode: style.bgMode, value: style.bgValue } : undefined);

  if (bg) {
    const startRow = Math.max(l.y - scrollOffset, 0);
    const endRow = Math.min(l.y + l.height - scrollOffset, buffer.height);
    const bgStyleId = styleTable.intern(0, ColorMode.Default, 0, bg.mode, bg.value);
    for (let row = startRow; row < endRow; row++) {
      for (let col = l.x; col < l.x + l.width; col++) {
        if (col >= buffer.width) break;
        writeCell(buffer, row, col, 0, bgStyleId, NO_LINK, NORMAL_WIDTH);
      }
    }
  }

  const hangingIndent = l.hangingIndent ?? 0;
  const clippedLines = Math.max(scrollOffset - l.y, 0);
  const textAlign = l.textAlign;

  let cellsWritten = 0;
  let continuationCells = 0;
  let vs16Count = 0;
  let skinToneCount = 0;
  let riCount = 0;
  let zwjCount = 0;

  for (let i = clippedLines; i < lines.length; i++) {
    const row = l.y + i - scrollOffset;
    if (row >= buffer.height) break;
    if (row < 0) continue;
    const xBase = i === 0 ? l.x : l.x + hangingIndent;
    const line = lines[i]!;

    // Compute per-line alignment offset
    let xStart = xBase;
    if (textAlign === 'center' || textAlign === 'right') {
      let lineLen = 0;
      for (const run of line) {
        if (perf) perf.count('stringDisplayWidthCalls');
        lineLen += stringDisplayWidth(run.text);
      }
      const slack = l.width - lineLen - (i === 0 ? 0 : hangingIndent);
      if (slack > 0) {
        xStart += textAlign === 'center' ? Math.floor(slack / 2) : slack;
      }
    }

    let col = xStart;
    // Track previous cell offset for grapheme cluster handling
    let prevCellOffset = -1;
    let prevCellCharStr = '';
    let prevCellWidth = 0;
    let prevCellStyleId = DEFAULT_STYLE;

    let prevWasZWJ = false;
    let prevWasRI = false;

    for (const run of line) {
      const runStyle = run.style ? resolveSegmentStyle(style, run.style, styleTable) : style;
      const runStyleId = runStyle.styleId;

      for (const ch of run.text) {
        const cp = ch.codePointAt(0)!;
        let w = charDisplayWidth(cp);

        // Grapheme cluster awareness
        let clusterAppend = false;
        if (w === 2 && prevCellOffset >= 0) {
          if (isSkinToneModifier(cp) && prevCellWidth === 2) {
            clusterAppend = true;
            skinToneCount++;
          } else if (isRegionalIndicator(cp) && prevWasRI) {
            clusterAppend = true;
            riCount++;
          } else if (prevWasZWJ) {
            clusterAppend = true;
            zwjCount++;
          }
        }

        if (clusterAppend) {
          // Append to previous cell's char
          prevCellCharStr += ch;
          const newCharId = charTable.intern(prevCellCharStr);
          // Rewrite the previous cell with the extended char
          const offset = prevCellOffset;
          buffer.cellWords[offset] = newCharId;
          prevWasZWJ = false;
          prevWasRI = false;
          continue;
        }

        if (w === 0) {
          // Combining mark / ZWJ / variation selector: attach to previous cell
          if (prevCellOffset >= 0) {
            prevCellCharStr += ch;
            // VS16 upgrade
            if (cp === 0xfe0f && prevCellWidth === 1 && col < buffer.width) {
              const baseCp = prevCellCharStr.codePointAt(0);
              if (baseCp !== undefined && isTextPresentationEmoji(baseCp)) {
                // Upgrade to width 2
                prevCellWidth = 2;
                vs16Count++;
                const newCharId = charTable.intern(prevCellCharStr);
                // Rewrite previous cell with wide width
                buffer.cellWords[prevCellOffset] = newCharId;
                buffer.cellWords[prevCellOffset + 1] = packMetaInline(runStyleId, NO_LINK, WIDE_WIDTH);
                // Write continuation cell at current col
                writeCell(buffer, row, col, EMPTY_CHAR, runStyleId, NO_LINK, CONTINUATION_WIDTH);
                continuationCells++;
                col++;
              } else {
                // Just update the char
                const newCharId = charTable.intern(prevCellCharStr);
                buffer.cellWords[prevCellOffset] = newCharId;
              }
            } else {
              // Just update the char
              const newCharId = charTable.intern(prevCellCharStr);
              buffer.cellWords[prevCellOffset] = newCharId;
            }
          }
          prevWasZWJ = cp === 0x200d;
          prevWasRI = false;
          continue;
        }

        if (w === 2 && col + 2 > buffer.width) break;
        if (col >= buffer.width) break;

        const charId = charTable.intern(ch);
        // Compute offset for direct access (for cluster append later)
        const cellOffset = (row * buffer.width + col) * 2;
        writeCell(buffer, row, col, charId, runStyleId, NO_LINK, w === 2 ? WIDE_WIDTH : NORMAL_WIDTH);
        prevCellOffset = cellOffset;
        prevCellCharStr = ch;
        prevCellWidth = w;
        prevCellStyleId = runStyleId;
        cellsWritten++;

        if (w === 2) {
          writeCell(buffer, row, col + 1, EMPTY_CHAR, runStyleId, NO_LINK, CONTINUATION_WIDTH);
          continuationCells++;
        }

        col += w;
        prevWasZWJ = false;
        prevWasRI = isRegionalIndicator(cp);
      }
    }
  }

  if (perf) {
    perf.count('cellsWritten', cellsWritten);
    perf.count('continuationCellsWritten', continuationCells);
    if (vs16Count) perf.count('vs16Upgrades', vs16Count);
    if (skinToneCount) perf.count('skinToneJoins', skinToneCount);
    if (riCount) perf.count('regionalIndicatorJoins', riCount);
    if (zwjCount) perf.count('zwjJoins', zwjCount);
    perf.timeEnd('rasterizeText');
  }
}

// --- paintRawAnsi: parse ANSI SGR escape sequences and write directly to cell buffer ---

function paintRawAnsi(
  node: TNode,
  inherited: ResolvedStyle,
  buffer: CellBuffer,
  charTable: CharTable,
  styleTable: StyleTable,
  linkTable: LinkTable,
  scrollOffset: number,
  perf?: Perf,
): void {
  if (perf) {
    perf.count('paintRawAnsiCalls');
    perf.timeStart('paintRawAnsi');
  }

  const l = node.layout!;
  const lines: string[] = node.props.lines;
  if (!lines || lines.length === 0) {
    if (perf) perf.timeEnd('paintRawAnsi');
    return;
  }

  // SGR parser state
  let attrs = inherited.attrs;
  let fgMode = inherited.fgMode;
  let fgValue = inherited.fgValue;
  let bgMode = inherited.bgMode;
  let bgValue = inherited.bgValue;

  let cellsWritten = 0;

  const clippedLines = Math.max(scrollOffset - l.y, 0);

  for (let i = clippedLines; i < lines.length; i++) {
    const row = l.y + i - scrollOffset;
    if (row >= buffer.height) break;
    if (row < 0) continue;

    const line = lines[i]!;
    let col = l.x;
    let j = 0;

    while (j < line.length) {
      // Check for ESC
      if (line.charCodeAt(j) === 0x1b && j + 1 < line.length && line.charCodeAt(j + 1) === 0x5b) {
        // Parse CSI sequence: ESC [ params m
        j += 2; // skip ESC [
        // Collect params
        let paramStart = j;
        while (j < line.length) {
          const c = line.charCodeAt(j);
          if (c >= 0x40 && c <= 0x7e) break; // final byte
          j++;
        }
        if (j < line.length && line.charCodeAt(j) === 0x6d) { // 'm'
          const paramStr = line.substring(paramStart, j);
          parseSgrParams(paramStr);
          j++; // skip 'm'
        } else {
          // Not SGR, skip final byte
          if (j < line.length) j++;
        }
        continue;
      }

      // Regular character
      if (col >= l.x + l.width || col >= buffer.width) {
        // Past the available width, skip rest of line
        break;
      }

      const cp = line.codePointAt(j)!;
      const chLen = cp > 0xffff ? 2 : 1;
      const ch = line.substring(j, j + chLen);
      j += chLen;

      const w = charDisplayWidth(cp);
      if (w === 0) continue; // skip zero-width chars in pre-rendered content

      if (w === 2 && col + 2 > buffer.width) break;

      const charId = charTable.intern(ch);
      const sid = styleTable.intern(attrs, fgMode, fgValue, bgMode, bgValue);

      writeCell(buffer, row, col, charId, sid, NO_LINK, w === 2 ? WIDE_WIDTH : NORMAL_WIDTH);
      cellsWritten++;

      if (w === 2) {
        writeCell(buffer, row, col + 1, EMPTY_CHAR, sid, NO_LINK, CONTINUATION_WIDTH);
        cellsWritten++;
      }

      col += w;
    }
  }

  if (perf) {
    perf.count('rawAnsiCellsWritten', cellsWritten);
    perf.timeEnd('paintRawAnsi');
  }

  // --- SGR param parser (closure over attrs/fgMode/fgValue/bgMode/bgValue) ---
  function parseSgrParams(paramStr: string): void {
    if (paramStr === '' || paramStr === '0') {
      // Reset
      attrs = 0;
      fgMode = ColorMode.Default;
      fgValue = 0;
      bgMode = ColorMode.Default;
      bgValue = 0;
      return;
    }

    const parts = paramStr.split(';');
    let pi = 0;
    while (pi < parts.length) {
      const n = parseInt(parts[pi]!, 10) || 0;

      switch (n) {
        case 0:
          attrs = 0;
          fgMode = ColorMode.Default; fgValue = 0;
          bgMode = ColorMode.Default; bgValue = 0;
          break;
        case 1: attrs |= Attr.Bold; break;
        case 2: attrs |= Attr.Dim; break;
        case 3: attrs |= Attr.Italic; break;
        case 4: attrs |= Attr.Underline; break;
        case 7: attrs |= Attr.Inverse; break;
        case 9: attrs |= Attr.Strikethrough; break;
        case 22: attrs &= ~(Attr.Bold | Attr.Dim); break;
        case 23: attrs &= ~Attr.Italic; break;
        case 24: attrs &= ~Attr.Underline; break;
        case 27: attrs &= ~Attr.Inverse; break;
        case 29: attrs &= ~Attr.Strikethrough; break;

        // Standard fg colors (30-37)
        case 30: case 31: case 32: case 33:
        case 34: case 35: case 36: case 37:
          fgMode = ColorMode.Palette; fgValue = n - 30; break;
        case 39: fgMode = ColorMode.Default; fgValue = 0; break;

        // Standard bg colors (40-47)
        case 40: case 41: case 42: case 43:
        case 44: case 45: case 46: case 47:
          bgMode = ColorMode.Palette; bgValue = n - 40; break;
        case 49: bgMode = ColorMode.Default; bgValue = 0; break;

        // Bright fg colors (90-97)
        case 90: case 91: case 92: case 93:
        case 94: case 95: case 96: case 97:
          fgMode = ColorMode.Palette; fgValue = n - 90 + 8; break;

        // Bright bg colors (100-107)
        case 100: case 101: case 102: case 103:
        case 104: case 105: case 106: case 107:
          bgMode = ColorMode.Palette; bgValue = n - 100 + 8; break;

        // Extended color: 38;5;N (256-color fg) or 38;2;R;G;B (RGB fg)
        case 38:
          if (pi + 1 < parts.length) {
            const sub = parseInt(parts[pi + 1]!, 10) || 0;
            if (sub === 5 && pi + 2 < parts.length) {
              fgMode = ColorMode.Palette;
              fgValue = parseInt(parts[pi + 2]!, 10) || 0;
              pi += 2;
            } else if (sub === 2 && pi + 4 < parts.length) {
              const r = parseInt(parts[pi + 2]!, 10) || 0;
              const g = parseInt(parts[pi + 3]!, 10) || 0;
              const b = parseInt(parts[pi + 4]!, 10) || 0;
              fgMode = ColorMode.RGB;
              fgValue = (r << 16) | (g << 8) | b;
              pi += 4;
            }
          }
          break;

        // Extended color: 48;5;N (256-color bg) or 48;2;R;G;B (RGB bg)
        case 48:
          if (pi + 1 < parts.length) {
            const sub = parseInt(parts[pi + 1]!, 10) || 0;
            if (sub === 5 && pi + 2 < parts.length) {
              bgMode = ColorMode.Palette;
              bgValue = parseInt(parts[pi + 2]!, 10) || 0;
              pi += 2;
            } else if (sub === 2 && pi + 4 < parts.length) {
              const r = parseInt(parts[pi + 2]!, 10) || 0;
              const g = parseInt(parts[pi + 3]!, 10) || 0;
              const b = parseInt(parts[pi + 4]!, 10) || 0;
              bgMode = ColorMode.RGB;
              bgValue = (r << 16) | (g << 8) | b;
              pi += 4;
            }
          }
          break;
      }
      pi++;
    }
  }
}

/** Inline pack for direct word writes (avoids import cycle with packMeta). */
function packMetaInline(styleId: number, linkId: number, width: number): number {
  return (styleId << 17) | (linkId << 2) | width;
}
