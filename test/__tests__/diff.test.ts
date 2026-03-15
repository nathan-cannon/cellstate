import { describe, test, expect } from "bun:test";
import fc from "fast-check";
import React from "react";
import { renderToString, Text, Box } from "ink";
import { diff, fullRedraw } from "../../src/diff.js";
import { parseAnsi } from "../ansi-parser.js";
import { VirtualScreen } from "../virtual-screen.js";
import {
  cellsEqual,
  createGrid,
  ColorMode,
  type Cell,
  type CellGrid,
  type Color,
} from "../../src/cell.js";

const e = React.createElement;

/** Render an Ink component to a CellGrid at the given width. */
function inkToGrid(node: React.ReactElement, cols: number, rows = 24): CellGrid {
  const ansi = renderToString(node, { columns: cols });
  // Ink outputs bare \n; xterm needs \r\n for proper line breaks
  return parseAnsi(ansi.replace(/\n/g, "\r\n"), cols, rows);
}


/**
 * Helper: seed a VirtualScreen with a grid via fullRedraw,
 * then apply a diff string. Returns the resulting grid.
 *
 * Positions cursor to prev's cursorRow/cursorCol after fullRedraw
 * so that the diff output (which assumes cursor starts there) works correctly.
 */
async function applyDiff(
  prev: CellGrid,
  diffStr: string,
  cols: number,
  rows: number
): Promise<CellGrid> {
  const screen = new VirtualScreen(cols, rows);
  await screen.write(fullRedraw(prev).output);
  // Move cursor to where diff() assumes it starts
  await screen.write(`\x1b[${prev.cursorRow + 1};${prev.cursorCol + 1}H`);
  if (diffStr.length > 0) {
    await screen.write(diffStr);
  }
  const result = screen.readGrid();
  screen.dispose();
  return result;
}

/**
 * Assert two grids have identical cell content (char + style).
 * Ignores cursor position.
 */
function assertGridsEqual(actual: CellGrid, expected: CellGrid) {
  expect(actual.width).toBe(expected.width);
  expect(actual.height).toBe(expected.height);
  for (let r = 0; r < expected.height; r++) {
    for (let c = 0; c < expected.width; c++) {
      const a = actual.cells[r][c];
      const e = expected.cells[r][c];
      if (!cellsEqual(a, e)) {
        throw new Error(
          `Cell mismatch at (${r},${c}): ` +
            `actual=${JSON.stringify(a)} expected=${JSON.stringify(e)}`
        );
      }
    }
  }
}

describe("diff", () => {
  test("no changes: identical grids produce empty output", () => {
    const grid = parseAnsi("hello world", 80);
    const result = diff(grid, grid);
    expect(result.output).toBe("");
  });

  test("single cell change: hello → jello", async () => {
    const prev = parseAnsi("hello", 80);
    const next = parseAnsi("jello", 80);
    const d = diff(prev, next);

    // Should be short — cursor move + style reset + 'j' + reset
    expect(d.output.length).toBeLessThan(30);

    const result = await applyDiff(prev, d.output, 80, 24);
    assertGridsEqual(result, next);
  });

  test("style-only change: same text, different color", async () => {
    const prev = parseAnsi("test", 80);
    const next = parseAnsi("\x1b[31mtest\x1b[0m", 80);
    const d = diff(prev, next);

    expect(d.output.length).toBeGreaterThan(0);

    const result = await applyDiff(prev, d.output, 80, 24);
    assertGridsEqual(result, next);
  });

  test("full line change", async () => {
    const prev = parseAnsi("line one\r\nline two\r\nline three", 80);
    const next = parseAnsi("line one\r\nCOMPLETELY DIFFERENT\r\nline three", 80);
    const d = diff(prev, next);

    const result = await applyDiff(prev, d.output, 80, 24);
    assertGridsEqual(result, next);
  });

  test("sparse changes: only touches changed lines", async () => {
    const lines = [
      "aaaaaaaaaa",
      "bbbbbbbbbb",
      "cccccccccc",
      "dddddddddd",
      "eeeeeeeeee",
    ];
    const prev = parseAnsi(lines.join("\r\n"), 80);

    const changed = [...lines];
    changed[0] = "Xbbbbbbbbb"; // change one char on line 0 (index 0, col 0 → X)
    changed[3] = "dddddYdddd"; // change one char on line 3
    const next = parseAnsi(changed.join("\r\n"), 80);

    const d = diff(prev, next);

    // The diff should be much shorter than rewriting all 5 lines
    // 5 full lines = 50 chars + moves. Diff should be ~2 cursor moves + 2 chars + style
    const fullRewriteLength = fullRedraw(next).output.length;
    expect(d.output.length).toBeLessThan(fullRewriteLength / 2);

    const result = await applyDiff(prev, d.output, 80, 24);
    assertGridsEqual(result, next);
  });

  test("clear line: text to empty", async () => {
    const prev = parseAnsi("some text here", 80);
    const next = createGrid(80, 24); // all empty
    const d = diff(prev, next);

    const result = await applyDiff(prev, d.output, 80, 24);
    assertGridsEqual(result, next);
  });

  test("wide char: ASCII to CJK", async () => {
    const prev = parseAnsi("ab", 80);
    const next = parseAnsi("你", 80); // wide char occupies cols 0-1
    const d = diff(prev, next);

    const result = await applyDiff(prev, d.output, 80, 24);
    // Check the specific cells
    expect(result.cells[0][0].char).toBe("你");
    expect(result.cells[0][1].char).toBe(""); // continuation
  });

  test("wide char: CJK to ASCII", async () => {
    const prev = parseAnsi("你好", 80); // cols 0-1: 你, cols 2-3: 好
    const next = parseAnsi("abcd", 80);
    const d = diff(prev, next);

    const result = await applyDiff(prev, d.output, 80, 24);
    assertGridsEqual(result, next);
  });

  test("fullRedraw: writes every cell using relative positioning", async () => {
    const target = parseAnsi("\x1b[31mhello\x1b[0m \x1b[1mworld\x1b[0m", 40, 10);
    const redraw = fullRedraw(target);

    // Should start with reset + relative up-movement + column 1
    expect(redraw.output.startsWith("\x1b[0m\x1b[")).toBe(true);
    // Must NOT contain absolute CUP sequences (\x1b[r;cH or \x1b[H)
    expect(redraw.output).not.toMatch(/\x1b\[(\d+(;\d+)?)?H/);

    // Apply to a blank screen
    const screen = new VirtualScreen(40, 10);
    await screen.write(redraw.output);
    const result = screen.readGrid();
    screen.dispose();

    assertGridsEqual(result, target);
  });

  test("round-trip property: random grids survive diff-apply", async () => {
    // Arbitrary for generating random cells
    const colorArb: fc.Arbitrary<Color> = fc.oneof(
      fc.constant({ mode: 0 as ColorMode, value: 0 }),
      fc.integer({ min: 0, max: 15 }).map((v) => ({
        mode: 1 as ColorMode,
        value: v,
      }))
    );

    const cellArb: fc.Arbitrary<Cell> = fc.record({
      char: fc.constantFrom(
        ..."abcdefghijklmnopqrstuvwxyz0123456789 ".split("")
      ),
      width: fc.constant(1), // only narrow chars in property test
      fg: colorArb,
      bg: colorArb,
      attrs: fc.constantFrom(0, 1, 2, 4), // none, bold, italic, underline
    });

    const cols = 20;
    const rows = 5;

    const gridArb: fc.Arbitrary<CellGrid> = fc
      .array(fc.array(cellArb, { minLength: cols, maxLength: cols }), {
        minLength: rows,
        maxLength: rows,
      })
      .map((cells) => ({
        cells,
        cursorRow: 0,
        cursorCol: 0,
        width: cols,
        height: rows,
      }));

    // We can't use fc.assert directly with async predicates,
    // so collect samples and verify them.
    const samples = fc.sample(fc.tuple(gridArb, gridArb), 200);

    for (const [prev, next] of samples) {
      const d = diff(prev, next);
      const result = await applyDiff(prev, d.output, cols, rows);
      assertGridsEqual(result, next);
    }
  });
});

// ── Ink integration tests ──────────────────────────────────────

describe("diff with real Ink output", () => {
  test("text content change", async () => {
    const gridA = inkToGrid(e(Text, null, "hello world"), 80);
    const gridB = inkToGrid(e(Text, null, "hello earth"), 80);
    const d = diff(gridA, gridB);

    const result = await applyDiff(gridA, d.output, 80, 24);
    assertGridsEqual(result, gridB);
  });

  test("color change", async () => {
    // renderToString and render() both strip colors when chalk detects no TTY.
    // Use raw ANSI to test diff's color-change detection directly.
    const gridA = parseAnsi("\x1b[31mhello\x1b[39m", 80); // red
    const gridB = parseAnsi("\x1b[34mhello\x1b[39m", 80); // blue

    // Verify colors were actually parsed differently
    expect(gridA.cells[0][0].fg.mode).not.toBe(ColorMode.Default);
    expect(gridB.cells[0][0].fg.mode).not.toBe(ColorMode.Default);
    expect(gridA.cells[0][0].fg.value).not.toBe(gridB.cells[0][0].fg.value);

    const d = diff(gridA, gridB);
    expect(d.output.length).toBeGreaterThan(0);
    const result = await applyDiff(gridA, d.output, 80, 24);
    assertGridsEqual(result, gridB);
  });

  test("layout change: middle line only", async () => {
    const gridA = inkToGrid(
      e(
        Box,
        { flexDirection: "column" },
        e(Text, null, "line 1"),
        e(Text, null, "line 2"),
        e(Text, null, "line 3")
      ),
      80
    );
    const gridB = inkToGrid(
      e(
        Box,
        { flexDirection: "column" },
        e(Text, null, "line 1"),
        e(Text, null, "CHANGED"),
        e(Text, null, "line 3")
      ),
      80
    );
    const d = diff(gridA, gridB);

    const result = await applyDiff(gridA, d.output, 80, 24);
    assertGridsEqual(result, gridB);

    // Diff should be shorter than a full redraw — only line 2 changed
    expect(d.output.length).toBeLessThan(fullRedraw(gridB).output.length / 2);
  });

  test("mixed styles: change only one styled segment", async () => {
    const gridA = inkToGrid(
      e(
        Box,
        { flexDirection: "column" },
        e(Text, { bold: true }, "bold text"),
        e(Text, { color: "green" }, "green text"),
        e(Text, null, "plain text")
      ),
      80
    );
    const gridB = inkToGrid(
      e(
        Box,
        { flexDirection: "column" },
        e(Text, { bold: true }, "bold text"),
        e(Text, { color: "red" }, "red text"),
        e(Text, null, "plain text")
      ),
      80
    );
    const d = diff(gridA, gridB);

    const result = await applyDiff(gridA, d.output, 80, 24);
    assertGridsEqual(result, gridB);
  });

  test("simulated message UI: only status line changes", async () => {
    const makeUI = (status: string) =>
      e(
        Box,
        { flexDirection: "column" },
        e(Text, { color: "cyan" }, "User: What is 2+2?"),
        e(Text, { color: "green" }, "Assistant: The answer is 4."),
        e(Text, { color: "cyan" }, "User: And 3+3?"),
        e(Text, { color: "green" }, "Assistant: That would be 6."),
        e(Text, { dimColor: true }, status)
      );

    const gridA = inkToGrid(makeUI("Status: idle"), 80);
    const gridB = inkToGrid(makeUI("Status: thinking..."), 80);
    const d = diff(gridA, gridB);

    const result = await applyDiff(gridA, d.output, 80, 24);
    assertGridsEqual(result, gridB);

    // Only the last line changed — diff should be much shorter than full redraw
    expect(d.output.length).toBeLessThan(fullRedraw(gridB).output.length / 3);
  });

  test("no absolute CUP sequences in diff or fullRedraw output", async () => {
    // Absolute CUP: \x1b[H, \x1b[5H, \x1b[5;3H — none should appear.
    // Relative CUU/CUD (\x1b[nA/B) and CHA (\x1b[nG) are fine.
    const absoluteCUP = /\x1b\[(\d+(;\d+)?)?H/;

    const gridA = inkToGrid(
      e(
        Box,
        { flexDirection: "column" },
        e(Text, null, "line 1"),
        e(Text, null, "line 2"),
        e(Text, null, "line 3"),
      ),
      80,
    );
    const gridB = inkToGrid(
      e(
        Box,
        { flexDirection: "column" },
        e(Text, null, "line 1"),
        e(Text, null, "CHANGED"),
        e(Text, null, "line 3"),
      ),
      80,
    );

    const redraw = fullRedraw(gridA);
    expect(redraw.output).not.toMatch(absoluteCUP);

    const d = diff(gridA, gridB);
    expect(d.output).not.toMatch(absoluteCUP);

    // Round-trip still works
    const result = await applyDiff(gridA, d.output, 80, 24);
    assertGridsEqual(result, gridB);
  });

  test("property: random Ink layouts survive diff round-trip", async () => {
    const colors = ["red", "green", "blue", "yellow", "white", "cyan"] as const;

    const lineArb = fc.record({
      text: fc.stringMatching(/^[\x20-\x7e]{1,30}$/),
      color: fc.constantFrom(...colors),
    });

    const caseArb = fc.record({
      cols: fc.integer({ min: 40, max: 160 }),
      lineCount: fc.integer({ min: 1, max: 10 }),
    }).chain(({ cols, lineCount }) =>
      fc.record({
        cols: fc.constant(cols),
        before: fc.array(lineArb, { minLength: lineCount, maxLength: lineCount }),
        after: fc.array(lineArb, { minLength: lineCount, maxLength: lineCount }),
      })
    );

    const samples = fc.sample(caseArb, 300);

    for (const { cols, before, after } of samples) {
      const rows = before.length + 4; // enough room

      const mkNode = (lines: { text: string; color: string }[]) =>
        e(
          Box,
          { flexDirection: "column" },
          ...lines.map((l, i) =>
            e(Text, { key: i, color: l.color }, l.text)
          )
        );

      const gridA = inkToGrid(mkNode(before), cols, rows);
      const gridB = inkToGrid(mkNode(after), cols, rows);

      const d = diff(gridA, gridB);
      const result = await applyDiff(gridA, d.output, cols, rows);
      assertGridsEqual(result, gridB);
    }
  });
});

// ---------------------------------------------------------------------------
// Stale pixel regression: spinner removal (content shrink) via diff
// ---------------------------------------------------------------------------

import { createNode, appendChild } from "../../src/tui/nodes.js";
import { layout, contentHeight } from "../../src/tui/layout.js";
import { rasterize } from "../../src/tui/rasterizer.js";

describe("stale pixel regression: spinner shrink", () => {
  const COLS = 127;
  const ROWS = 25;

  /**
   * Build a TNode tree resembling the real app layout:
   *   root
   *     box (main content, gap=1)
   *       header box (11 text lines)
   *       user message box (1 line)
   *       tool group box (1 line)
   *       [spinner box (1 line)] — optional
   *       input box (1 line: "❯ █")
   *     box (fixed="bottom", status bar, 1 line)
   */
  function buildTree(withSpinner: boolean) {
    const root = createNode("root");

    // Main content box with gap=1
    const mainBox = createNode("box", { gap: 1 });
    appendChild(root, mainBox);

    // Header: 11 text lines in a box
    const headerBox = createNode("box");
    appendChild(mainBox, headerBox);
    for (let i = 0; i < 11; i++) {
      const t = createNode("text");
      const inst = createNode("text");
      inst.text = `Header line ${i}`;
      appendChild(t, inst);
      appendChild(headerBox, t);
    }

    // User message box (gray background)
    const userBox = createNode("box", { backgroundColor: "#303030" });
    appendChild(mainBox, userBox);
    const userText = createNode("text", {
      segments: [
        { text: "❯ ", style: { fg: "#585858" } },
        { text: "hello world", style: { fg: "#ffffff" } },
      ],
    });
    appendChild(userBox, userText);

    // Tool group (1 line)
    const toolBox = createNode("box");
    appendChild(mainBox, toolBox);
    const toolText = createNode("text", {
      segments: [{ text: "● Reading 3 files…", style: { fg: "#00ff00" } }],
    });
    appendChild(toolBox, toolText);

    // Spinner (optional)
    if (withSpinner) {
      const spinnerBox = createNode("box");
      appendChild(mainBox, spinnerBox);
      const spinnerText = createNode("text", {
        segments: [{ text: "⠋ Thinking...", style: { dim: true } }],
      });
      appendChild(spinnerBox, spinnerText);
    }

    // Input prompt
    const inputBox = createNode("box");
    appendChild(mainBox, inputBox);
    const inputText = createNode("text", {
      segments: [
        { text: "❯ ", style: { dim: true } },
        { text: "█", style: { bold: true } },
      ],
    });
    appendChild(inputBox, inputText);

    // Status bar (regular content-flow child)
    const statusBar = createNode("box");
    appendChild(root, statusBar);
    const statusText = createNode("text", {
      segments: [{ text: "tokens: 1234 | cost: $0.01" }],
    });
    appendChild(statusBar, statusText);

    layout(root, COLS, ROWS);
    const ch = contentHeight(root);

    return { root, ch };
  }

  test("diff correctly clears spinner row when content shrinks", async () => {
    // Build tree WITH spinner
    const withSpinner = buildTree(true);
    const grid1 = rasterize(withSpinner.root, COLS, ROWS, 0);

    // Build tree WITHOUT spinner (content shrinks by 2: spinner line + gap)
    const noSpinner = buildTree(false);
    const grid2 = rasterize(noSpinner.root, COLS, ROWS, 0);

    // Sanity: grids should have same dimensions
    expect(grid1.width).toBe(COLS);
    expect(grid1.height).toBe(ROWS);
    expect(grid2.width).toBe(COLS);
    expect(grid2.height).toBe(ROWS);

    // Sanity: content heights differ
    expect(withSpinner.ch).toBeGreaterThan(noSpinner.ch);

    // Seed VirtualScreen with grid1 via fullRedraw
    const screen = new VirtualScreen(COLS, ROWS);
    const redraw1 = fullRedraw(grid1, 0);
    await screen.write(`\x1b[H` + redraw1.output);

    // Now apply diff (simulating what doUpdateFrame does)
    const d = diff(grid1, grid2, 0, 0);
    await screen.write(`\x1b[H` + d.output);

    // Read result and compare cell-by-cell
    const result = screen.readGrid();
    screen.dispose();

    // Find the spinner row in grid1 (look for "Thinking")
    let spinnerRow = -1;
    for (let r = 0; r < ROWS; r++) {
      let rowStr = "";
      for (let c = 0; c < Math.min(20, COLS); c++) {
        rowStr += grid1.cells[r][c].char;
      }
      if (rowStr.includes("Thinking")) {
        spinnerRow = r;
        break;
      }
    }
    expect(spinnerRow).toBeGreaterThan(0);

    // After applying the diff, VirtualScreen should match grid2 exactly.
    let mismatches: string[] = [];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const actual = result.cells[r][c];
        const expected = grid2.cells[r][c];
        if (!cellsEqual(actual, expected)) {
          mismatches.push(
            `(${r},${c}): actual='${actual.char}' expected='${expected.char}'`
          );
        }
      }
    }

    if (mismatches.length > 0) {
      const summary = mismatches.slice(0, 20).join("\n");
      throw new Error(
        `Grid mismatch after diff: ${mismatches.length} cells differ.\n` +
          `Spinner was at row ${spinnerRow}.\n` +
          `First mismatches:\n${summary}`
      );
    }
  });

  test("fullRedraw correctly covers all rows including spinner area", async () => {
    // Build tree WITH spinner, render via fullRedraw
    const withSpinner = buildTree(true);
    const grid1 = rasterize(withSpinner.root, COLS, ROWS, 0);

    // Build tree WITHOUT spinner, render via fullRedraw
    const noSpinner = buildTree(false);
    const grid2 = rasterize(noSpinner.root, COLS, ROWS, 0);

    // Seed screen with grid1
    const screen = new VirtualScreen(COLS, ROWS);
    await screen.write(`\x1b[H` + fullRedraw(grid1, 0).output);

    // Now do a full redraw with grid2 (simulating what happens when prevGrid=null)
    await screen.write(`\x1b[H` + fullRedraw(grid2, 0).output);

    const result = screen.readGrid();
    screen.dispose();

    // Should match grid2 exactly
    assertGridsEqual(result, grid2);
  });
});
