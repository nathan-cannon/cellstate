import { describe, test, expect } from "bun:test";
import fc from "fast-check";
import XtermHeadless from "@xterm/headless";
const { Terminal } = XtermHeadless;
import { parseAnsi } from "../ansi-parser.js";
import { ColorMode, Attr } from "../../src/cell.js";
import { renderMarkdown } from "./markdown-helper.js";

describe("parseAnsi", () => {
  test("plain text", () => {
    const grid = parseAnsi("hello", 80);
    const chars = grid.cells[0].slice(0, 5).map((c) => c.char);
    expect(chars).toEqual(["h", "e", "l", "l", "o"]);
    expect(grid.cells[0][5].char).toBe(" ");
  });

  test("colors: red foreground (basic)", () => {
    const grid = parseAnsi("\x1b[31mred\x1b[0m", 80);
    const rCell = grid.cells[0][0];
    expect(rCell.char).toBe("r");
    expect(rCell.fg.mode).toBe(ColorMode.Palette);
    expect(rCell.fg.value).toBe(1);

    const dCell = grid.cells[0][2];
    expect(dCell.char).toBe("d");
    expect(dCell.fg.mode).toBe(ColorMode.Palette);
    expect(dCell.fg.value).toBe(1);
  });

  test("cursor position after newline", () => {
    const grid = parseAnsi("ab\r\ncd", 80);
    expect(grid.cursorRow).toBe(1);
    expect(grid.cursorCol).toBe(2);
    expect(grid.cells[0][0].char).toBe("a");
    expect(grid.cells[0][1].char).toBe("b");
    expect(grid.cells[1][0].char).toBe("c");
    expect(grid.cells[1][1].char).toBe("d");
  });

  test("line wrapping", () => {
    const grid = parseAnsi("abcde", 3);
    expect(grid.cells[0].slice(0, 3).map((c) => c.char)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(grid.cells[1][0].char).toBe("d");
    expect(grid.cells[1][1].char).toBe("e");
  });

  test("wide characters", () => {
    const grid = parseAnsi("你好", 80);
    expect(grid.cells[0][0].char).toBe("你");
    expect(grid.cells[0][1].char).toBe(""); // continuation
    expect(grid.cells[0][2].char).toBe("好");
    expect(grid.cells[0][3].char).toBe(""); // continuation
  });

  test("background color (basic)", () => {
    const grid = parseAnsi("\x1b[41mhi\x1b[0m", 80);
    expect(grid.cells[0][0].bg.mode).toBe(ColorMode.Palette);
    expect(grid.cells[0][0].bg.value).toBe(1);
  });

  test("bold attribute", () => {
    const grid = parseAnsi("\x1b[1mbold\x1b[0m", 80);
    expect(grid.cells[0][0].attrs & Attr.Bold).toBe(Attr.Bold);
  });

  // ── 256-color ──────────────────────────────────────────────

  test("256-color foreground", () => {
    const grid = parseAnsi("\x1b[38;5;196mX\x1b[0m", 80);
    const cell = grid.cells[0][0];
    expect(cell.char).toBe("X");
    expect(cell.fg.mode).toBe(ColorMode.Palette);
    expect(cell.fg.value).toBe(196);
  });

  test("256-color background", () => {
    const grid = parseAnsi("\x1b[48;5;21mY\x1b[0m", 80);
    const cell = grid.cells[0][0];
    expect(cell.char).toBe("Y");
    expect(cell.bg.mode).toBe(ColorMode.Palette);
    expect(cell.bg.value).toBe(21);
  });

  test("256-color fg + bg combined", () => {
    const grid = parseAnsi("\x1b[38;5;196m\x1b[48;5;21mZ\x1b[0m", 80);
    const cell = grid.cells[0][0];
    expect(cell.fg.mode).toBe(ColorMode.Palette);
    expect(cell.fg.value).toBe(196);
    expect(cell.bg.mode).toBe(ColorMode.Palette);
    expect(cell.bg.value).toBe(21);
  });

  // ── Truecolor ──────────────────────────────────────────────

  test("truecolor foreground", () => {
    const grid = parseAnsi("\x1b[38;2;255;128;0mT\x1b[0m", 80);
    const cell = grid.cells[0][0];
    expect(cell.char).toBe("T");
    expect(cell.fg.mode).toBe(ColorMode.RGB);
    // 255<<16 | 128<<8 | 0 = 0xFF8000 = 16744448
    expect(cell.fg.value).toBe(0xff8000);
  });

  test("truecolor background", () => {
    const grid = parseAnsi("\x1b[48;2;0;128;255mU\x1b[0m", 80);
    const cell = grid.cells[0][0];
    expect(cell.bg.mode).toBe(ColorMode.RGB);
    expect(cell.bg.value).toBe(0x0080ff);
  });

  // ── Multiple styles (chalk-like output) ────────────────────

  test("bold + color then reset", () => {
    const grid = parseAnsi("\x1b[1;38;5;208mbright\x1b[0m plain", 80);
    // "bright" should be bold + palette 208
    const bCell = grid.cells[0][0];
    expect(bCell.char).toBe("b");
    expect(bCell.attrs & Attr.Bold).toBe(Attr.Bold);
    expect(bCell.fg.mode).toBe(ColorMode.Palette);
    expect(bCell.fg.value).toBe(208);

    // "plain" (after reset) should have default style
    const pCell = grid.cells[0][7]; // "p" of "plain"
    expect(pCell.char).toBe("p");
    expect(pCell.attrs).toBe(0);
    expect(pCell.fg.mode).toBe(ColorMode.Default);
  });

  test("italic + underline + truecolor", () => {
    const grid = parseAnsi("\x1b[3;4;38;2;100;200;50mfancy\x1b[0m", 80);
    const cell = grid.cells[0][0];
    expect(cell.attrs & Attr.Italic).toBe(Attr.Italic);
    expect(cell.attrs & Attr.Underline).toBe(Attr.Underline);
    expect(cell.fg.mode).toBe(ColorMode.RGB);
    expect(cell.fg.value).toBe((100 << 16) | (200 << 8) | 50);
  });

  // ── renderMarkdown through parseAnsi ───────────────────────

  const markdownSample = [
    "# Heading",
    "",
    "Some **bold** text and `inline code`.",
    "",
    "```js",
    "const x = 42;",
    "console.log(x);",
    "```",
    "",
    "- item one",
    "- item two",
    "- item three",
  ].join("\n");

  test("renderMarkdown at 80 cols", () => {
    const ansi = renderMarkdown(markdownSample);
    const grid = parseAnsi(ansi, 80, 40);

    // Should not crash and should produce non-empty cells
    let nonEmpty = 0;
    for (const row of grid.cells) {
      for (const cell of row) {
        if (cell.char !== " " && cell.char !== "") nonEmpty++;
      }
    }
    expect(nonEmpty).toBeGreaterThan(0);

    // The heading text "Heading" should appear somewhere in the grid
    const debugText = grid.cells
      .map((row) => row.map((c) => c.char || "").join(""))
      .join("");
    expect(debugText).toContain("Heading");
  });

  test("renderMarkdown at 40 cols", () => {
    const ansi = renderMarkdown(markdownSample);
    const grid = parseAnsi(ansi, 40, 60);

    let nonEmpty = 0;
    for (const row of grid.cells) {
      for (const cell of row) {
        if (cell.char !== " " && cell.char !== "") nonEmpty++;
      }
    }
    expect(nonEmpty).toBeGreaterThan(0);

    const debugText = grid.cells
      .map((row) => row.map((c) => c.char || "").join(""))
      .join("");
    expect(debugText).toContain("Heading");
    expect(debugText).toContain("item one");
  });

  // ── Property-based ─────────────────────────────────────────

  test("property: printable ASCII text and cursor bounds", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[\x20-\x7e]{0,200}$/),
        fc.integer({ min: 10, max: 200 }),
        (input: string, cols: number) => {
          const rows = Math.max(24, Math.ceil(input.length / cols) + 2);
          const grid = parseAnsi(input, cols, rows);

          // Read back exactly input.length cells in row-major order
          // and verify the text matches
          let extracted = "";
          let r = 0;
          let c = 0;
          for (let i = 0; i < input.length; i++) {
            extracted += grid.cells[r][c].char;
            c++;
            if (c >= cols) {
              c = 0;
              r++;
            }
          }
          expect(extracted).toBe(input);

          expect(grid.cursorRow).toBeGreaterThanOrEqual(0);
          expect(grid.cursorRow).toBeLessThan(rows);
          expect(grid.cursorCol).toBeGreaterThanOrEqual(0);
          expect(grid.cursorCol).toBeLessThanOrEqual(cols);
        }
      ),
      { numRuns: 500 }
    );
  });

  // ── xterm color mode constant assertions ────────────────────
  // Guards against silent breakage on @xterm/headless upgrade.
  // Our buffer-reader.ts uses hardcoded constants for color modes;
  // these tests verify xterm still reports the same values.

  test("xterm palette color mode constant (0x2000000)", () => {
    const term = new Terminal({ cols: 10, rows: 2, allowProposedApi: true });
    (term as any)._core.writeSync("\x1b[38;5;196mX");
    const cell = term.buffer.active.getLine(0)!.getCell(0)!;
    expect(cell.getFgColorMode()).toBe(33554432); // 0x2000000
    expect(cell.getFgColor()).toBe(196);
    term.dispose();
  });

  test("xterm RGB color mode constant (0x3000000)", () => {
    const term = new Terminal({ cols: 10, rows: 2, allowProposedApi: true });
    (term as any)._core.writeSync("\x1b[38;2;255;0;0mX");
    const cell = term.buffer.active.getLine(0)!.getCell(0)!;
    expect(cell.getFgColorMode()).toBe(50331648); // 0x3000000
    expect(cell.getFgColor()).toBe(0xff0000);
    term.dispose();
  });

  test("xterm default color mode constant (0)", () => {
    const term = new Terminal({ cols: 10, rows: 2, allowProposedApi: true });
    (term as any)._core.writeSync("X");
    const cell = term.buffer.active.getLine(0)!.getCell(0)!;
    expect(cell.getFgColorMode()).toBe(0);
    term.dispose();
  });
});
