import { describe, test, expect } from 'bun:test';
import {
  createCellBuffer,
  clearBuffer,
  resizeBuffer,
  writeCell,
  readCell,
  readCellCharId,
  readCellMeta,
  blitRegion,
  shiftRows,
  applyContentCeiling,
  bufferToText,
  isDamaged,
  lastNonBlankRow,
  packMeta,
  NORMAL_WIDTH,
  WIDE_WIDTH,
  CONTINUATION_WIDTH,
  BLANK_CELL_64,
} from '../../src/core/cell-buffer.js';
import { CharTable, SPACE_CHAR, EMPTY_CHAR } from '../../src/core/char-table.js';
import { StyleTable, DEFAULT_STYLE } from '../../src/core/style-table.js';
import { LinkTable, NO_LINK } from '../../src/core/link-table.js';
import { ColorMode, Attr } from '../../src/core/cell.js';

describe('CellBuffer', () => {
  describe('createCellBuffer', () => {
    test('produces correct dimensions', () => {
      const buf = createCellBuffer(80, 24);
      expect(buf.width).toBe(80);
      expect(buf.height).toBe(24);
      expect(buf.capacity).toBe(24);
    });

    test('starts with all-blank content', () => {
      const buf = createCellBuffer(10, 5);
      for (let r = 0; r < 5; r++) {
        for (let c = 0; c < 10; c++) {
          const cell = readCell(buf, r, c)!;
          expect(cell.charId).toBe(SPACE_CHAR);
          expect(cell.styleId).toBe(DEFAULT_STYLE);
          expect(cell.linkId).toBe(NO_LINK);
          expect(cell.width).toBe(NORMAL_WIDTH);
        }
      }
    });

    test('all-blank cells are zero in bulk view', () => {
      const buf = createCellBuffer(10, 5);
      for (let i = 0; i < 10 * 5; i++) {
        expect(buf.cellBulk[i]).toBe(BLANK_CELL_64);
      }
    });

    test('damageBox starts null', () => {
      const buf = createCellBuffer(10, 5);
      expect(buf.damageBox).toBeNull();
      expect(isDamaged(buf)).toBe(false);
    });
  });

  describe('writeCell + readCell', () => {
    test('round-trips ASCII cell', () => {
      const ct = new CharTable();
      const buf = createCellBuffer(10, 5);
      const charId = ct.intern('A');
      writeCell(buf, 0, 0, charId, DEFAULT_STYLE, NO_LINK, NORMAL_WIDTH);
      const cell = readCell(buf, 0, 0)!;
      expect(cell.charId).toBe(charId);
      expect(cell.styleId).toBe(DEFAULT_STYLE);
      expect(cell.linkId).toBe(NO_LINK);
      expect(cell.width).toBe(NORMAL_WIDTH);
      expect(ct.resolve(cell.charId)).toBe('A');
    });

    test('round-trips CJK wide cell', () => {
      const ct = new CharTable();
      const buf = createCellBuffer(10, 5);
      const charId = ct.intern('中');
      writeCell(buf, 1, 0, charId, DEFAULT_STYLE, NO_LINK, WIDE_WIDTH);
      writeCell(buf, 1, 1, EMPTY_CHAR, DEFAULT_STYLE, NO_LINK, CONTINUATION_WIDTH);
      const cell = readCell(buf, 1, 0)!;
      expect(cell.charId).toBe(charId);
      expect(cell.width).toBe(WIDE_WIDTH);
      const cont = readCell(buf, 1, 1)!;
      expect(cont.charId).toBe(EMPTY_CHAR);
      expect(cont.width).toBe(CONTINUATION_WIDTH);
    });

    test('round-trips emoji cell', () => {
      const ct = new CharTable();
      const buf = createCellBuffer(10, 5);
      const charId = ct.intern('🎉');
      writeCell(buf, 0, 0, charId, DEFAULT_STYLE, NO_LINK, WIDE_WIDTH);
      const cell = readCell(buf, 0, 0)!;
      expect(ct.resolve(cell.charId)).toBe('🎉');
      expect(cell.width).toBe(WIDE_WIDTH);
    });

    test('round-trips styled cell', () => {
      const ct = new CharTable();
      const st = new StyleTable();
      const buf = createCellBuffer(10, 5);
      const charId = ct.intern('X');
      const styleId = st.intern(Attr.Bold | Attr.Italic, ColorMode.RGB, 0xff0000, ColorMode.Default, 0);
      writeCell(buf, 2, 3, charId, styleId, NO_LINK, NORMAL_WIDTH);
      const cell = readCell(buf, 2, 3)!;
      expect(cell.charId).toBe(charId);
      expect(cell.styleId).toBe(styleId);
    });

    test('round-trips hyperlinked cell', () => {
      const ct = new CharTable();
      const lt = new LinkTable();
      const buf = createCellBuffer(10, 5);
      const charId = ct.intern('L');
      const linkId = lt.intern('https://example.com');
      writeCell(buf, 0, 0, charId, DEFAULT_STYLE, linkId, NORMAL_WIDTH);
      const cell = readCell(buf, 0, 0)!;
      expect(cell.linkId).toBe(linkId);
      expect(lt.resolve(cell.linkId)).toBe('https://example.com');
    });

    test('out of bounds write is silently ignored', () => {
      const buf = createCellBuffer(10, 5);
      writeCell(buf, -1, 0, 0, 0, 0, NORMAL_WIDTH);
      writeCell(buf, 5, 0, 0, 0, 0, NORMAL_WIDTH);
      writeCell(buf, 0, 10, 0, 0, 0, NORMAL_WIDTH);
      writeCell(buf, 0, -1, 0, 0, 0, NORMAL_WIDTH);
      // No crash, no damage
      expect(isDamaged(buf)).toBe(false);
    });

    test('out of bounds read returns null', () => {
      const buf = createCellBuffer(10, 5);
      expect(readCell(buf, -1, 0)).toBeNull();
      expect(readCell(buf, 5, 0)).toBeNull();
      expect(readCell(buf, 0, 10)).toBeNull();
    });
  });

  describe('readCellCharId / readCellMeta', () => {
    test('fast-path readers match readCell', () => {
      const ct = new CharTable();
      const st = new StyleTable();
      const buf = createCellBuffer(10, 5);
      const charId = ct.intern('Z');
      const styleId = st.intern(Attr.Bold, ColorMode.Palette, 5, ColorMode.Default, 0);
      writeCell(buf, 1, 2, charId, styleId, NO_LINK, NORMAL_WIDTH);
      expect(readCellCharId(buf, 1, 2)).toBe(charId);
      expect(readCellMeta(buf, 1, 2)).toBe(packMeta(styleId, NO_LINK, NORMAL_WIDTH));
    });
  });

  describe('clearBuffer', () => {
    test('resets everything to blank', () => {
      const ct = new CharTable();
      const buf = createCellBuffer(10, 5);
      writeCell(buf, 0, 0, ct.intern('A'), DEFAULT_STYLE, NO_LINK, NORMAL_WIDTH);
      writeCell(buf, 4, 9, ct.intern('Z'), DEFAULT_STYLE, NO_LINK, NORMAL_WIDTH);
      clearBuffer(buf);
      for (let r = 0; r < 5; r++) {
        for (let c = 0; c < 10; c++) {
          expect(buf.cellBulk[r * 10 + c]).toBe(BLANK_CELL_64);
        }
      }
      expect(buf.damageBox).toBeNull();
    });
  });

  describe('damageBox', () => {
    test('expands correctly with writes', () => {
      const ct = new CharTable();
      const buf = createCellBuffer(10, 5);
      writeCell(buf, 1, 3, ct.intern('A'), DEFAULT_STYLE, NO_LINK, NORMAL_WIDTH);
      expect(buf.damageBox).toEqual({ minRow: 1, maxRow: 1, minCol: 3, maxCol: 3 });
      writeCell(buf, 3, 7, ct.intern('B'), DEFAULT_STYLE, NO_LINK, NORMAL_WIDTH);
      expect(buf.damageBox).toEqual({ minRow: 1, maxRow: 3, minCol: 3, maxCol: 7 });
      writeCell(buf, 0, 0, ct.intern('C'), DEFAULT_STYLE, NO_LINK, NORMAL_WIDTH);
      expect(buf.damageBox).toEqual({ minRow: 0, maxRow: 3, minCol: 0, maxCol: 7 });
    });
  });

  describe('blitRegion', () => {
    test('copies cells correctly', () => {
      const ct = new CharTable();
      const src = createCellBuffer(10, 5);
      const dst = createCellBuffer(10, 5);
      // Write pattern into src
      writeCell(src, 0, 0, ct.intern('A'), DEFAULT_STYLE, NO_LINK, NORMAL_WIDTH);
      writeCell(src, 0, 1, ct.intern('B'), DEFAULT_STYLE, NO_LINK, NORMAL_WIDTH);
      writeCell(src, 1, 0, ct.intern('C'), DEFAULT_STYLE, NO_LINK, NORMAL_WIDTH);
      writeCell(src, 1, 1, ct.intern('D'), DEFAULT_STYLE, NO_LINK, NORMAL_WIDTH);
      // Blit 2x2 region from src(0,0) to dst(2,3)
      blitRegion(src, dst, 0, 0, 2, 3, 2, 2);
      expect(readCell(dst, 2, 3)!.charId).toBe(ct.intern('A'));
      expect(readCell(dst, 2, 4)!.charId).toBe(ct.intern('B'));
      expect(readCell(dst, 3, 3)!.charId).toBe(ct.intern('C'));
      expect(readCell(dst, 3, 4)!.charId).toBe(ct.intern('D'));
    });

    test('does NOT expand damage on destination', () => {
      const ct = new CharTable();
      const src = createCellBuffer(10, 5);
      const dst = createCellBuffer(10, 5);
      writeCell(src, 0, 0, ct.intern('X'), DEFAULT_STYLE, NO_LINK, NORMAL_WIDTH);
      blitRegion(src, dst, 0, 0, 0, 0, 1, 1);
      // Blitted content is identical — no damage expansion needed
      expect(dst.damageBox).toBeNull();
    });

    test('clamps to bounds', () => {
      const src = createCellBuffer(5, 5);
      const dst = createCellBuffer(5, 5);
      // No crash when region extends past bounds
      blitRegion(src, dst, 3, 3, 3, 3, 10, 10);
    });
  });

  describe('shiftRows', () => {
    test('shifts rows down and blanks vacated space', () => {
      const ct = new CharTable();
      const buf = createCellBuffer(5, 5);
      writeCell(buf, 0, 0, ct.intern('A'), DEFAULT_STYLE, NO_LINK, NORMAL_WIDTH);
      writeCell(buf, 1, 0, ct.intern('B'), DEFAULT_STYLE, NO_LINK, NORMAL_WIDTH);
      shiftRows(buf, 0, 3, 2);
      // Row 0 was at 0 → now at 2
      expect(readCell(buf, 2, 0)!.charId).toBe(ct.intern('A'));
      // Row 1 was at 1 → now at 3
      expect(readCell(buf, 3, 0)!.charId).toBe(ct.intern('B'));
      // Vacated rows 0,1 should be blank
      expect(buf.cellBulk[0 * 5 + 0]).toBe(BLANK_CELL_64);
      expect(buf.cellBulk[1 * 5 + 0]).toBe(BLANK_CELL_64);
    });

    test('shifts rows up and blanks vacated space', () => {
      const ct = new CharTable();
      const buf = createCellBuffer(5, 5);
      writeCell(buf, 2, 0, ct.intern('X'), DEFAULT_STYLE, NO_LINK, NORMAL_WIDTH);
      writeCell(buf, 3, 0, ct.intern('Y'), DEFAULT_STYLE, NO_LINK, NORMAL_WIDTH);
      shiftRows(buf, 2, 4, -2);
      expect(readCell(buf, 0, 0)!.charId).toBe(ct.intern('X'));
      expect(readCell(buf, 1, 0)!.charId).toBe(ct.intern('Y'));
      // Vacated rows 2,3 should be blank
      expect(buf.cellBulk[2 * 5 + 0]).toBe(BLANK_CELL_64);
      expect(buf.cellBulk[3 * 5 + 0]).toBe(BLANK_CELL_64);
    });
  });

  describe('resizeBuffer', () => {
    test('growth allocates larger capacity', () => {
      const buf = createCellBuffer(10, 5);
      const resized = resizeBuffer(buf, 20, 10);
      expect(resized.width).toBe(20);
      expect(resized.height).toBe(10);
      expect(resized.capacity).toBeGreaterThanOrEqual(10);
      // Should have new backing arrays large enough
      expect(resized.cellWords.length).toBeGreaterThanOrEqual(20 * 10 * 2);
    });

    test('shrink reuses backing arrays when possible', () => {
      const buf = createCellBuffer(10, 10);
      const originalWords = buf.cellWords;
      const resized = resizeBuffer(buf, 5, 5);
      expect(resized.width).toBe(5);
      expect(resized.height).toBe(5);
      // Same backing arrays reused
      expect(resized.cellWords).toBe(originalWords);
    });

    test('resized buffer is cleared', () => {
      const ct = new CharTable();
      const buf = createCellBuffer(10, 5);
      writeCell(buf, 0, 0, ct.intern('A'), DEFAULT_STYLE, NO_LINK, NORMAL_WIDTH);
      const resized = resizeBuffer(buf, 10, 5);
      // After resize, should be all blank within active area
      for (let r = 0; r < 5; r++) {
        for (let c = 0; c < 10; c++) {
          const cell = readCell(resized, r, c)!;
          expect(cell.charId).toBe(SPACE_CHAR);
        }
      }
    });
  });

  describe('applyContentCeiling', () => {
    test('drops top rows correctly', () => {
      const ct = new CharTable();
      const buf = createCellBuffer(5, 5);
      for (let r = 0; r < 5; r++) {
        writeCell(buf, r, 0, ct.intern(String.fromCharCode(65 + r)), DEFAULT_STYLE, NO_LINK, NORMAL_WIDTH);
      }
      // A=0, B=1, C=2, D=3, E=4; ceiling to 3 → drop A and B
      const dropped = applyContentCeiling(buf, 3);
      expect(dropped).toBe(2);
      expect(buf.height).toBe(3);
      // Row 0 should now be what was row 2 (C)
      expect(readCell(buf, 0, 0)!.charId).toBe(ct.intern('C'));
      expect(readCell(buf, 1, 0)!.charId).toBe(ct.intern('D'));
      expect(readCell(buf, 2, 0)!.charId).toBe(ct.intern('E'));
    });

    test('returns 0 when height <= maxHeight', () => {
      const buf = createCellBuffer(5, 3);
      expect(applyContentCeiling(buf, 5)).toBe(0);
      expect(applyContentCeiling(buf, 3)).toBe(0);
    });
  });

  describe('bufferToText', () => {
    test('produces readable output', () => {
      const ct = new CharTable();
      const buf = createCellBuffer(5, 3);
      // Write "Hello" on row 0
      for (let i = 0; i < 5; i++) {
        writeCell(buf, 0, i, ct.intern('Hello'[i]!), DEFAULT_STYLE, NO_LINK, NORMAL_WIDTH);
      }
      // Write wide char on row 1
      writeCell(buf, 1, 0, ct.intern('中'), DEFAULT_STYLE, NO_LINK, WIDE_WIDTH);
      writeCell(buf, 1, 1, EMPTY_CHAR, DEFAULT_STYLE, NO_LINK, CONTINUATION_WIDTH);
      const text = bufferToText(buf, ct);
      const lines = text.split('\n');
      expect(lines[0]).toBe('Hello');
      expect(lines[1]).toBe('中');
      expect(lines[2]).toBe('');
    });
  });

  describe('lastNonBlankRow', () => {
    test('finds the correct row', () => {
      const ct = new CharTable();
      const buf = createCellBuffer(10, 10);
      expect(lastNonBlankRow(buf)).toBe(0); // all blank
      writeCell(buf, 3, 0, ct.intern('X'), DEFAULT_STYLE, NO_LINK, NORMAL_WIDTH);
      expect(lastNonBlankRow(buf)).toBe(3);
      writeCell(buf, 7, 5, ct.intern('Y'), DEFAULT_STYLE, NO_LINK, NORMAL_WIDTH);
      expect(lastNonBlankRow(buf)).toBe(7);
    });
  });

  describe('packMeta', () => {
    test('packs and unpacks correctly', () => {
      const styleId = 100;
      const linkId = 200;
      const width = WIDE_WIDTH;
      const meta = packMeta(styleId, linkId, width);
      expect((meta >>> 17) & 0x7fff).toBe(styleId);
      expect((meta >>> 2) & 0x7fff).toBe(linkId);
      expect(meta & 0x3).toBe(width);
    });

    test('blank cell meta is 0', () => {
      expect(packMeta(DEFAULT_STYLE, NO_LINK, NORMAL_WIDTH)).toBe(0);
    });
  });
});
