/**
 * Tests for the paintRawAnsi path in paint.ts.
 * Verifies that ANSI SGR codes are correctly parsed into the cell buffer.
 */
import { describe, it, expect } from 'bun:test';
import { paintTree } from '../../src/core/paint.js';
import { createNode, appendChild, type TNode, type LayoutResult } from '../../src/core/nodes.js';
import { Attr, ColorMode } from '../../src/core/cell.js';
import { CharTable, SPACE_CHAR } from '../../src/core/char-table.js';
import { StyleTable, DEFAULT_STYLE } from '../../src/core/style-table.js';
import { LinkTable } from '../../src/core/link-table.js';
import {
  createCellBuffer,
  readCell,
  bufferToText,
  type CellBuffer,
} from '../../src/core/cell-buffer.js';

function makeTables() {
  return { ct: new CharTable(), st: new StyleTable(), lt: new LinkTable() };
}

function rawAnsiNode(
  lines: string[],
  rawWidth: number,
  layout: LayoutResult,
): TNode {
  const n = createNode('raw-ansi', { lines, rawWidth });
  n.layout = layout;
  return n;
}

function paintAndRead(lines: string[], width: number, height: number) {
  const { ct, st, lt } = makeTables();
  const buf = createCellBuffer(width, height);

  const root = createNode('root', {});
  root.layout = { x: 0, y: 0, width, height };
  const child = rawAnsiNode(lines, width, {
    x: 0, y: 0, width, height: lines.length,
  });
  appendChild(root, child);

  paintTree(root, buf, null, ct, st, lt, 0);
  return { buf, ct, st, lt };
}

describe('paintRawAnsi', () => {
  it('paints plain text without escapes', () => {
    const { buf, ct } = paintAndRead(['Hello', 'World'], 10, 2);
    const text = bufferToText(buf, ct);
    expect(text).toContain('Hello');
    expect(text).toContain('World');
  });

  it('paints text at the correct position', () => {
    const { ct, st, lt } = makeTables();
    const buf = createCellBuffer(20, 5);

    const root = createNode('root', {});
    root.layout = { x: 0, y: 0, width: 20, height: 5 };
    const child = rawAnsiNode(['AB'], 10, {
      x: 3, y: 1, width: 10, height: 1,
    });
    appendChild(root, child);

    paintTree(root, buf, null, ct, st, lt, 0);

    // Row 1, col 3 should be 'A'
    const cellA = readCell(buf, 1, 3);
    expect(ct.resolve(cellA.charId)).toBe('A');
    // Row 1, col 4 should be 'B'
    const cellB = readCell(buf, 1, 4);
    expect(ct.resolve(cellB.charId)).toBe('B');
  });

  it('parses bold SGR codes', () => {
    const { buf, ct, st } = paintAndRead(['\x1b[1mBold\x1b[0m'], 10, 1);

    const cell = readCell(buf, 0, 0);
    expect(ct.resolve(cell.charId)).toBe('B');
    const style = st.resolve(cell.styleId);
    expect(style.attrs & Attr.Bold).toBeTruthy();
  });

  it('parses italic and dim SGR codes', () => {
    const { buf, ct, st } = paintAndRead(['\x1b[3mItalic\x1b[0m \x1b[2mDim\x1b[0m'], 20, 1);

    const cellI = readCell(buf, 0, 0);
    expect(ct.resolve(cellI.charId)).toBe('I');
    const styleI = st.resolve(cellI.styleId);
    expect(styleI.attrs & Attr.Italic).toBeTruthy();

    // 'D' is at position 7 (after "Italic ")
    const cellD = readCell(buf, 0, 7);
    expect(ct.resolve(cellD.charId)).toBe('D');
    const styleD = st.resolve(cellD.styleId);
    expect(styleD.attrs & Attr.Dim).toBeTruthy();
  });

  it('parses standard 8-color foreground', () => {
    const { buf, st } = paintAndRead(['\x1b[31mRed\x1b[0m'], 10, 1);

    const cell = readCell(buf, 0, 0);
    const style = st.resolve(cell.styleId);
    expect(style.fgMode).toBe(ColorMode.Palette);
    expect(style.fgValue).toBe(1); // red = 31 - 30
  });

  it('parses bright foreground colors (90-97)', () => {
    const { buf, st } = paintAndRead(['\x1b[94mBrightBlue\x1b[0m'], 20, 1);

    const cell = readCell(buf, 0, 0);
    const style = st.resolve(cell.styleId);
    expect(style.fgMode).toBe(ColorMode.Palette);
    expect(style.fgValue).toBe(12); // 94 - 90 + 8
  });

  it('parses 256-color foreground (38;5;N)', () => {
    const { buf, st } = paintAndRead(['\x1b[38;5;208mOrange\x1b[0m'], 20, 1);

    const cell = readCell(buf, 0, 0);
    const style = st.resolve(cell.styleId);
    expect(style.fgMode).toBe(ColorMode.Palette);
    expect(style.fgValue).toBe(208);
  });

  it('parses RGB foreground (38;2;R;G;B)', () => {
    const { buf, st } = paintAndRead(['\x1b[38;2;255;128;0mRGB\x1b[0m'], 20, 1);

    const cell = readCell(buf, 0, 0);
    const style = st.resolve(cell.styleId);
    expect(style.fgMode).toBe(ColorMode.RGB);
    expect(style.fgValue).toBe((255 << 16) | (128 << 8) | 0);
  });

  it('parses background colors (40-47)', () => {
    const { buf, st } = paintAndRead(['\x1b[42mGreenBg\x1b[0m'], 20, 1);

    const cell = readCell(buf, 0, 0);
    const style = st.resolve(cell.styleId);
    expect(style.bgMode).toBe(ColorMode.Palette);
    expect(style.bgValue).toBe(2); // green = 42 - 40
  });

  it('parses RGB background (48;2;R;G;B)', () => {
    const { buf, st } = paintAndRead(['\x1b[48;2;10;20;30mRGB-Bg\x1b[0m'], 20, 1);

    const cell = readCell(buf, 0, 0);
    const style = st.resolve(cell.styleId);
    expect(style.bgMode).toBe(ColorMode.RGB);
    expect(style.bgValue).toBe((10 << 16) | (20 << 8) | 30);
  });

  it('handles reset correctly', () => {
    const { buf, st } = paintAndRead(['\x1b[1;31mBoldRed\x1b[0mPlain'], 20, 1);

    // 'B' should be bold + red
    const cellB = readCell(buf, 0, 0);
    const styleB = st.resolve(cellB.styleId);
    expect(styleB.attrs & Attr.Bold).toBeTruthy();
    expect(styleB.fgMode).toBe(ColorMode.Palette);

    // 'P' (at position 7) should be default
    const cellP = readCell(buf, 0, 7);
    const styleP = st.resolve(cellP.styleId);
    expect(styleP.attrs).toBe(0);
    expect(styleP.fgMode).toBe(ColorMode.Default);
  });

  it('handles combined attributes in one sequence', () => {
    const { buf, st } = paintAndRead(['\x1b[1;3;4mBIU\x1b[0m'], 10, 1);

    const cell = readCell(buf, 0, 0);
    const style = st.resolve(cell.styleId);
    expect(style.attrs & Attr.Bold).toBeTruthy();
    expect(style.attrs & Attr.Italic).toBeTruthy();
    expect(style.attrs & Attr.Underline).toBeTruthy();
  });

  it('handles attribute reset codes (22, 23, 24)', () => {
    const { buf, st } = paintAndRead(['\x1b[1;3;4mBIU\x1b[22mNoB\x1b[23mNoI\x1b[24mNoU'], 20, 1);

    // 'N' at position 6 (after "BIU" + "NoB" start) - bold should be off
    const cellNoB = readCell(buf, 0, 3);
    const styleNoB = st.resolve(cellNoB.styleId);
    expect(styleNoB.attrs & Attr.Bold).toBeFalsy();
    expect(styleNoB.attrs & Attr.Italic).toBeTruthy();
    expect(styleNoB.attrs & Attr.Underline).toBeTruthy();
  });

  it('handles multi-line content', () => {
    const lines = [
      '\x1b[1mLine 1\x1b[0m',
      '\x1b[3mLine 2\x1b[0m',
      'Line 3',
    ];
    const { buf, ct, st } = paintAndRead(lines, 20, 3);

    // Row 0: bold
    const cell0 = readCell(buf, 0, 0);
    expect(ct.resolve(cell0.charId)).toBe('L');
    expect(st.resolve(cell0.styleId).attrs & Attr.Bold).toBeTruthy();

    // Row 1: italic
    const cell1 = readCell(buf, 1, 0);
    expect(ct.resolve(cell1.charId)).toBe('L');
    expect(st.resolve(cell1.styleId).attrs & Attr.Italic).toBeTruthy();

    // Row 2: default
    const cell2 = readCell(buf, 2, 0);
    expect(ct.resolve(cell2.charId)).toBe('L');
    expect(st.resolve(cell2.styleId).attrs).toBe(0);
  });

  it('respects scroll offset', () => {
    const { ct, st, lt } = makeTables();
    const buf = createCellBuffer(10, 2);

    const root = createNode('root', {});
    root.layout = { x: 0, y: 0, width: 10, height: 5 };
    const child = rawAnsiNode(['Line0', 'Line1', 'Line2', 'Line3'], 10, {
      x: 0, y: 0, width: 10, height: 4,
    });
    appendChild(root, child);

    paintTree(root, buf, null, ct, st, lt, 1); // scroll offset 1

    // Row 0 of buffer should show "Line1" (second line, due to scroll)
    const cell = readCell(buf, 0, 0);
    expect(ct.resolve(cell.charId)).toBe('L');
    const cell4 = readCell(buf, 0, 4);
    expect(ct.resolve(cell4.charId)).toBe('1');
  });

  it('clips content at buffer width', () => {
    const { buf, ct } = paintAndRead(['0123456789ABCDEF'], 10, 1);

    // Should only paint 10 chars
    const text = bufferToText(buf, ct);
    expect(text.trim()).toBe('0123456789');
  });

  it('handles wide characters (CJK)', () => {
    const { buf, ct } = paintAndRead(['A你B'], 10, 1);

    const cellA = readCell(buf, 0, 0);
    expect(ct.resolve(cellA.charId)).toBe('A');

    const cellCJK = readCell(buf, 0, 1);
    expect(ct.resolve(cellCJK.charId)).toBe('你');

    // Continuation cell
    const cellCont = readCell(buf, 0, 2);
    expect(cellCont.width).toBe(2); // CONTINUATION_WIDTH

    const cellB = readCell(buf, 0, 3);
    expect(ct.resolve(cellB.charId)).toBe('B');
  });

  it('handles strikethrough and inverse', () => {
    const { buf, st } = paintAndRead(['\x1b[9mStrike\x1b[0m\x1b[7mInverse\x1b[0m'], 20, 1);

    const cellS = readCell(buf, 0, 0);
    expect(st.resolve(cellS.styleId).attrs & Attr.Strikethrough).toBeTruthy();

    const cellI = readCell(buf, 0, 6);
    expect(st.resolve(cellI.styleId).attrs & Attr.Inverse).toBeTruthy();
  });
});
