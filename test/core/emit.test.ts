import { describe, test, expect } from 'bun:test';
import {
  diffBuffers,
  serializeNewRows,
  serializeRowsForExit,
  serializeRowRange,
} from '../../src/core/emit.js';
import {
  createCellBuffer,
  clearBuffer,
  writeCell,
  readCell,
  blitRegion,
  expandDamageForShrink,
  NORMAL_WIDTH,
  WIDE_WIDTH,
  CONTINUATION_WIDTH,
  type CellBuffer,
} from '../../src/core/cell-buffer.js';
import { CharTable, SPACE_CHAR, EMPTY_CHAR } from '../../src/core/char-table.js';
import { StyleTable, DEFAULT_STYLE } from '../../src/core/style-table.js';
import { LinkTable, NO_LINK } from '../../src/core/link-table.js';
import { ColorMode, Attr } from '../../src/core/cell.js';

function makeTables() {
  return { ct: new CharTable(), st: new StyleTable(), lt: new LinkTable() };
}

/** Write a string into a buffer row starting at col. */
function writeString(
  buf: CellBuffer,
  row: number,
  col: number,
  text: string,
  ct: CharTable,
  styleId = DEFAULT_STYLE,
): void {
  let c = col;
  for (const ch of text) {
    writeCell(buf, row, c, ct.intern(ch), styleId, NO_LINK, NORMAL_WIDTH);
    c++;
  }
}

describe('diffBuffers', () => {
  test('both buffers with no damage → empty output', () => {
    const { ct, st } = makeTables();
    const front = createCellBuffer(10, 5);
    const back = createCellBuffer(10, 5);
    // Neither buffer has any damage
    const output = diffBuffers(front, back, st, ct, new LinkTable(), false);
    expect(output).toBe('');
  });

  test('single character change produces cursor move + char', () => {
    const { ct, st } = makeTables();
    const front = createCellBuffer(10, 5);
    const back = createCellBuffer(10, 5);
    writeString(front, 0, 0, 'hello', ct);
    front.damageBox = null;

    writeString(back, 0, 0, 'hXllo', ct);

    const output = diffBuffers(front, back, st, ct, new LinkTable(), false);
    // Should contain the character 'X'
    expect(output).toContain('X');
    // Should have a cursor movement to column 1 (CSI 2G)
    expect(output).toContain('\x1b[2G');
    // Should NOT contain 'h', 'l', 'l', 'o' (unchanged)
    // The output should be relatively short
    expect(output.length).toBeLessThan(30);
  });

  test('style change produces SGR transition', () => {
    const { ct, st } = makeTables();
    const boldId = st.intern(Attr.Bold, ColorMode.Default, 0, ColorMode.Default, 0);

    const front = createCellBuffer(10, 1);
    writeString(front, 0, 0, 'A', ct);
    front.damageBox = null;

    const back = createCellBuffer(10, 1);
    writeCell(back, 0, 0, ct.intern('A'), boldId, NO_LINK, NORMAL_WIDTH);

    const output = diffBuffers(front, back, st, ct, new LinkTable(), false);
    // Should contain SGR for bold (ESC[1m or similar)
    expect(output).toContain('1');
    expect(output).toContain('m');
  });

  test('row that became blank produces erase sequence', () => {
    const { ct, st } = makeTables();
    const front = createCellBuffer(10, 3);
    writeString(front, 1, 0, 'hello', ct);
    front.damageBox = null;

    const back = createCellBuffer(10, 3);
    // Row 1 is blank in back (default), had content in front.
    // Use expandDamageForShrink to include the erased row in damage bounds.
    expandDamageForShrink(front, back);

    const output = diffBuffers(front, back, st, ct, new LinkTable(), false);
    // Should contain erase-to-end or erase-line
    expect(output).toMatch(/\x1b\[\d*K/);
  });

  test('new rows (height grew) are emitted', () => {
    const { ct, st } = makeTables();
    const front = createCellBuffer(10, 2);
    writeString(front, 0, 0, 'A', ct);
    front.damageBox = null;

    const back = createCellBuffer(10, 4);
    writeString(back, 0, 0, 'A', ct);
    writeString(back, 2, 0, 'new', ct);

    const output = diffBuffers(front, back, st, ct, new LinkTable(), false);
    expect(output).toContain('n');
    expect(output).toContain('e');
    expect(output).toContain('w');
  });

  test('unchanged rows are skipped entirely', () => {
    const { ct, st } = makeTables();
    const front = createCellBuffer(10, 3);
    writeString(front, 0, 0, 'unchanged', ct);
    writeString(front, 1, 0, 'also same', ct);
    writeString(front, 2, 0, 'different', ct);
    front.damageBox = null;

    const back = createCellBuffer(10, 3);
    writeString(back, 0, 0, 'unchanged', ct);
    writeString(back, 1, 0, 'also same', ct);
    writeString(back, 2, 0, 'DIFFERENT', ct);

    const output = diffBuffers(front, back, st, ct, new LinkTable(), false);
    // Should contain 'DIFFERENT' chars but NOT 'unchanged' or 'also same'
    expect(output).toContain('D');
    expect(output).toContain('I');
    expect(output).not.toContain('unchanged');
    expect(output).not.toContain('also same');
  });

  test('wide characters diff correctly', () => {
    const { ct, st } = makeTables();
    const front = createCellBuffer(10, 1);
    writeCell(front, 0, 0, ct.intern('你'), DEFAULT_STYLE, NO_LINK, WIDE_WIDTH);
    writeCell(front, 0, 1, EMPTY_CHAR, DEFAULT_STYLE, NO_LINK, CONTINUATION_WIDTH);
    front.damageBox = null;

    const back = createCellBuffer(10, 1);
    writeCell(back, 0, 0, ct.intern('好'), DEFAULT_STYLE, NO_LINK, WIDE_WIDTH);
    writeCell(back, 0, 1, EMPTY_CHAR, DEFAULT_STYLE, NO_LINK, CONTINUATION_WIDTH);

    const output = diffBuffers(front, back, st, ct, new LinkTable(), false);
    expect(output).toContain('好');
    // Should NOT contain the continuation cell's empty string
  });
});

describe('diffBuffers — content shrink (front taller than back)', () => {
  test('erases rows that existed in front but not in back', () => {
    const { ct, st } = makeTables();
    // Front: 30 rows of content in a 40-row viewport
    const front = createCellBuffer(20, 30);
    for (let r = 0; r < 30; r++) {
      writeString(front, r, 0, `row${r}`, ct);
    }
    front.damageBox = null;

    // Back: shrunk to 20 rows — rows 20-29 no longer exist
    const back = createCellBuffer(20, 20);
    for (let r = 0; r < 20; r++) {
      writeString(back, r, 0, `row${r}`, ct);
    }

    const output = diffBuffers(front, back, st, ct, new LinkTable(), false);
    // Rows 20-29 had content in front → should be erased
    const eraseCount = (output.match(/\x1b\[2K/g) || []).length;
    expect(eraseCount).toBe(10);
  });

  test('does not erase blank excess front rows', () => {
    const { ct, st } = makeTables();
    // Front: 10 rows, only first 5 have content, rest blank
    const front = createCellBuffer(20, 10);
    for (let r = 0; r < 5; r++) {
      writeString(front, r, 0, `line${r}`, ct);
    }
    front.damageBox = null;

    // Back: shrunk to 5 rows
    const back = createCellBuffer(20, 5);
    for (let r = 0; r < 5; r++) {
      writeString(back, r, 0, `line${r}`, ct);
    }

    const output = diffBuffers(front, back, st, ct, new LinkTable(), false);
    // Rows 5-9 were blank in front → no erase needed
    const eraseCount = (output.match(/\x1b\[2K/g) || []).length;
    expect(eraseCount).toBe(0);
  });

  test('erases only non-blank excess rows when mixed', () => {
    const { ct, st } = makeTables();
    // Front: 8 rows, content at rows 0-3 and 6-7, rows 4-5 blank
    const front = createCellBuffer(20, 8);
    for (let r = 0; r < 4; r++) {
      writeString(front, r, 0, `line${r}`, ct);
    }
    // rows 4-5 are blank
    writeString(front, 6, 0, 'extra1', ct);
    writeString(front, 7, 0, 'extra2', ct);
    front.damageBox = null;

    // Back: shrunk to 4 rows
    const back = createCellBuffer(20, 4);
    for (let r = 0; r < 4; r++) {
      writeString(back, r, 0, `line${r}`, ct);
    }

    const output = diffBuffers(front, back, st, ct, new LinkTable(), false);
    // Rows 4-5 blank → skip, rows 6-7 had content → erase
    const eraseCount = (output.match(/\x1b\[2K/g) || []).length;
    expect(eraseCount).toBe(2);
  });

  test('no stale content remains after shrink', () => {
    const { ct, st } = makeTables();
    const front = createCellBuffer(10, 6);
    for (let r = 0; r < 6; r++) {
      writeString(front, r, 0, `R${r}`, ct);
    }
    front.damageBox = null;

    const back = createCellBuffer(10, 3);
    for (let r = 0; r < 3; r++) {
      writeString(back, r, 0, `R${r}`, ct);
    }

    const output = diffBuffers(front, back, st, ct, new LinkTable(), false);
    // The output should NOT contain any of the removed row content
    expect(output).not.toContain('R3');
    expect(output).not.toContain('R4');
    expect(output).not.toContain('R5');
    // But should contain erase sequences for them
    const eraseCount = (output.match(/\x1b\[2K/g) || []).length;
    expect(eraseCount).toBe(3);
  });
});

describe('serializeNewRows', () => {
  test('produces correct output for a range of rows', () => {
    const { ct, st } = makeTables();
    const buf = createCellBuffer(5, 5);
    writeString(buf, 2, 0, 'abc', ct);
    writeString(buf, 3, 0, 'def', ct);
    writeString(buf, 4, 0, 'ghi', ct);

    const result = serializeNewRows(buf, 2, 5, st, ct, new LinkTable(), false);
    expect(result.output).toContain('abc');
    expect(result.output).toContain('def');
    expect(result.output).toContain('ghi');
    // Uses pending-wrap separator (space + backspace) between rows
    expect(result.output).toContain(' \x08');
  });
});

describe('serializeRowsForExit', () => {
  test('uses real newlines and trims trailing spaces', () => {
    const { ct, st } = makeTables();
    const buf = createCellBuffer(10, 3);
    writeString(buf, 0, 0, 'hello', ct);
    writeString(buf, 1, 0, 'world', ct);
    // Row 2 is blank

    const result = serializeRowsForExit(buf, st, ct, new LinkTable(), false);
    // Should use real newlines, not space+backspace
    expect(result.output).toContain('\n');
    expect(result.output).not.toContain('\x08');
    // Content should be there
    expect(result.output).toContain('hello');
    expect(result.output).toContain('world');
  });
});

describe('serializeRowRange', () => {
  test('emits all rows including blanks', () => {
    const { ct, st } = makeTables();
    const buf = createCellBuffer(5, 4);
    writeString(buf, 0, 0, 'A', ct);
    // Row 1 is blank
    writeString(buf, 2, 0, 'B', ct);

    const result = serializeRowRange(buf, 0, 3, st, ct, new LinkTable(), false);
    expect(result.output).toContain('A');
    expect(result.output).toContain('B');
    // Should have row separators for all 3 rows
    const separatorCount = (result.output.match(/ \x08/g) || []).length;
    expect(separatorCount).toBe(2); // between row 0-1 and 1-2
  });
});

describe('diffBuffers — damage scoping', () => {
  test('damage-scoped diff only iterates damaged rows', () => {
    const { ct, st } = makeTables();
    // Front: 10 rows of content, damage cleared
    const front = createCellBuffer(10, 10);
    for (let r = 0; r < 10; r++) {
      writeString(front, r, 0, `row${r}`, ct);
    }
    front.damageBox = null;

    // Back: same content except row 5 changed
    const back = createCellBuffer(10, 10);
    for (let r = 0; r < 10; r++) {
      writeString(back, r, 0, r === 5 ? 'CHANGED' : `row${r}`, ct);
    }

    const output = diffBuffers(front, back, st, ct, new LinkTable(), false);
    expect(output).toContain('C');
    expect(output).toContain('H');
    expect(output).not.toContain('row0');
    expect(output).not.toContain('row9');
  });
});

describe('integration — diff with styled content', () => {
  test('style transitions use StyleTable.transition cache', () => {
    const { ct, st } = makeTables();
    const redId = st.intern(0, ColorMode.RGB, 0xff0000, ColorMode.Default, 0);
    const blueId = st.intern(0, ColorMode.RGB, 0x0000ff, ColorMode.Default, 0);

    const front = createCellBuffer(10, 1);
    writeCell(front, 0, 0, ct.intern('R'), redId, NO_LINK, NORMAL_WIDTH);
    front.damageBox = null;

    const back = createCellBuffer(10, 1);
    writeCell(back, 0, 0, ct.intern('B'), blueId, NO_LINK, NORMAL_WIDTH);

    const output = diffBuffers(front, back, st, ct, new LinkTable(), false);
    // The transition from red to blue is a fg-only change
    const expectedTransition = st.transition(redId, blueId);
    expect(output).toContain(expectedTransition);
    expect(output).toContain('B');
  });

  test('diff then serialize produces valid ANSI ending with reset', () => {
    const { ct, st } = makeTables();
    const boldId = st.intern(Attr.Bold, ColorMode.Default, 0, ColorMode.Default, 0);

    const front = createCellBuffer(10, 1);
    const back = createCellBuffer(10, 1);
    writeCell(back, 0, 0, ct.intern('X'), boldId, NO_LINK, NORMAL_WIDTH);

    const output = diffBuffers(front, back, st, ct, new LinkTable(), false);
    // Should end with SGR reset since a non-default style was active
    expect(output.endsWith('\x1b[0m')).toBe(true);
  });
});
