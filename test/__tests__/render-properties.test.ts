import { describe, test } from "bun:test";
import fc from "fast-check";
import { diff, fullRedraw } from "../../src/diff.js";
import {
  cellsEqual,
  createGrid,
  ColorMode,
  Attr,
  type Cell,
  type CellGrid,
  type Color,
} from "../../src/cell.js";
import { VirtualScreen } from "../virtual-screen.js";
import { createNode, appendChild, type TNode, type Segment, type SegmentStyle } from "../../src/tui/nodes.js";
import { layout, contentHeight } from "../../src/tui/layout.js";
import { rasterize } from "../../src/tui/rasterizer.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Produce a compact human-readable description of a grid for failure logging.
 * Each row shows the characters, then a second line with non-default cell styles.
 */
function describeGrid(grid: CellGrid): string {
  const lines: string[] = [];
  for (let r = 0; r < grid.height; r++) {
    const row = grid.cells[r]!;
    const chars = row.map((c) => (c.char === "" ? " " : c.char)).join("");
    lines.push(`row ${r}: "${chars}"`);

    const annotations: string[] = [];
    for (let c = 0; c < row.length; c++) {
      const cell = row[c]!;
      const parts: string[] = [];
      if (cell.width === 2) parts.push("w2");
      if (cell.attrs & Attr.Bold) parts.push("B");
      if (cell.attrs & Attr.Italic) parts.push("I");
      if (cell.attrs & Attr.Underline) parts.push("U");
      if (cell.attrs & Attr.Dim) parts.push("D");
      if (cell.fg.mode === ColorMode.Palette) parts.push(`R${cell.fg.value}`);
      if (cell.fg.mode === ColorMode.RGB)
        parts.push(`#${cell.fg.value.toString(16).padStart(6, "0")}`);
      if (cell.bg.mode === ColorMode.Palette) parts.push(`BG${cell.bg.value}`);
      if (cell.bg.mode === ColorMode.RGB)
        parts.push(`BG#${cell.bg.value.toString(16).padStart(6, "0")}`);
      if (parts.length > 0) annotations.push(`[${c}:${parts.join(",")}]`);
    }
    if (annotations.length > 0) {
      lines.push("      " + annotations.join(" "));
    }
  }
  return lines.join("\n");
}

/**
 * Seed a VirtualScreen with fullRedraw(prev), then position cursor at (0,0)
 * (matching diff(prev, next, 0, 0) which assumes cursor starts there),
 * then apply diff. Returns the resulting grid. Caller is responsible for dispose().
 */
async function applyDiff(
  prev: CellGrid,
  diffStr: string,
  cols: number,
  rows: number,
): Promise<CellGrid> {
  const screen = new VirtualScreen(cols, rows);
  await screen.write(fullRedraw(prev, 0).output);
  // Position cursor at (0,0) — matches diff(prev, next, 0, 0) start assumption
  await screen.write(`\x1b[H`);
  if (diffStr.length > 0) {
    await screen.write(diffStr);
  }
  return screen.readGrid();
}

/**
 * Assert two grids match cell-by-cell.
 * Skips spacer cells (width=0, char="") — their attrs are set by the terminal
 * as a side effect of wide chars and don't reflect explicit content.
 * On failure, throws with full diagnostic info.
 */
function assertGridsEqual(
  actual: CellGrid,
  expected: CellGrid,
  label: string,
  seed: number,
  iteration: number,
  diffOutput?: string,
): void {
  if (actual.width !== expected.width || actual.height !== expected.height) {
    throw new Error(
      `[seed=${seed} iter=${iteration}] ${label}: dimension mismatch ` +
        `actual=${actual.width}x${actual.height} expected=${expected.width}x${expected.height}`,
    );
  }
  for (let r = 0; r < expected.height; r++) {
    for (let c = 0; c < expected.width; c++) {
      const a = actual.cells[r]![c]!;
      const e = expected.cells[r]![c]!;
      // Skip spacer cells — their attrs are inherited from the preceding wide
      // char by the terminal and don't reflect the generated grid's explicit content.
      if (e.width === 0 && e.char === "" && a.width === 0 && a.char === "") continue;
      if (!cellsEqual(a, e)) {
        const hexOutput = diffOutput
          ? Buffer.from(diffOutput).toString("hex")
          : "(no diff output)";
        throw new Error(
          `[seed=${seed} iter=${iteration}] ${label}: cell mismatch at (row=${r},col=${c})\n` +
            `  actual:   ${JSON.stringify(a)}\n` +
            `  expected: ${JSON.stringify(e)}\n` +
            `  grid dimensions: ${expected.width}x${expected.height}\n` +
            `  diff output hex: ${hexOutput}\n` +
            `  actual grid:\n${describeGrid(actual)}\n` +
            `  expected grid:\n${describeGrid(expected)}`,
        );
      }
    }
  }
}

// ─── Shared Arbitraries ─────────────────────────────────────────────────────

/** Weighted color arbitrary: 50% Default, 30% Palette, 20% RGB */
const colorArb: fc.Arbitrary<Color> = fc.oneof(
  { weight: 5, arbitrary: fc.constant({ mode: ColorMode.Default as ColorMode, value: 0 }) },
  {
    weight: 3,
    arbitrary: fc.integer({ min: 0, max: 255 }).map((v) => ({
      mode: ColorMode.Palette as ColorMode,
      value: v,
    })),
  },
  {
    weight: 2,
    arbitrary: fc.integer({ min: 0x000000, max: 0xffffff }).map((v) => ({
      mode: ColorMode.RGB as ColorMode,
      value: v,
    })),
  },
);

// Wide chars: only CJK that xterm-headless reliably treats as width 2.
// Emoji (🎉, 🚀) are intentionally excluded — xterm-headless reports them as
// width 1, so generating grids with emoji width=2 would produce grids that don't
// match what any real xterm would render.
const WIDE_CHARS = ["你", "好", "世", "界"];
const NARROW_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789 !@#$%^&*()-_=+[]{}|;:',.<>?/".split("");

/**
 * Cell arbitrary: handles ASCII (width=1), CJK/emoji (width=2).
 * For wide chars, the caller (gridArb) must place spacer cells.
 */
const cellArb: fc.Arbitrary<Cell & { _isWide?: boolean }> = fc.oneof(
  {
    weight: 8,
    arbitrary: fc.record({
      char: fc.constantFrom(...NARROW_CHARS),
      width: fc.constant(1),
      fg: colorArb,
      bg: colorArb,
      attrs: fc.integer({ min: 0, max: 7 }), // Bold|Italic|Underline combos
    }),
  },
  {
    weight: 2,
    arbitrary: fc
      .record({
        char: fc.constantFrom(...WIDE_CHARS),
        width: fc.constant(2),
        fg: colorArb,
        bg: colorArb,
        attrs: fc.integer({ min: 0, max: 7 }),
      })
      .map((c) => ({ ...c, _isWide: true })),
  },
);

/** Default (blank) cell */
function blankCell(): Cell {
  return {
    char: " ",
    width: 1,
    fg: { mode: ColorMode.Default, value: 0 },
    bg: { mode: ColorMode.Default, value: 0 },
    attrs: 0,
  };
}

/** Spacer cell for wide char continuation */
function spacerCell(): Cell {
  return {
    char: "",
    width: 0,
    fg: { mode: ColorMode.Default, value: 0 },
    bg: { mode: ColorMode.Default, value: 0 },
    attrs: 0,
  };
}

/**
 * Build a valid CellGrid of given dimensions.
 * Handles wide chars by inserting spacer cells. If a wide char would land
 * at the last column, replaces it with a space (can't fit).
 * 10% chance of fully blank grid.
 */
function gridArb(cols: number, rows: number): fc.Arbitrary<CellGrid> {
  return fc.tuple(
    fc.array(
      fc.array(cellArb, { minLength: cols, maxLength: cols }),
      { minLength: rows, maxLength: rows },
    ),
    fc.integer({ min: 0, max: rows - 1 }),
    fc.integer({ min: 0, max: cols - 1 }),
    fc.float({ min: 0, max: 1 }),
  ).map(([rawRows, cursorRow, cursorCol, blankChance]) => {
    // 10% chance: all blank grid
    if (blankChance < 0.1) {
      const grid = createGrid(cols, rows);
      grid.cursorRow = cursorRow;
      grid.cursorCol = cursorCol;
      return grid;
    }

    const cells: Cell[][] = [];
    for (let r = 0; r < rows; r++) {
      const rawRow = rawRows[r]!;
      const row: Cell[] = [];
      let c = 0;
      while (c < cols) {
        const raw = rawRow[c]!;
        if ((raw as any)._isWide && c < cols - 1) {
          // Place wide char + spacer
          const cell: Cell = {
            char: raw.char,
            width: raw.width,
            fg: raw.fg,
            bg: raw.bg,
            attrs: raw.attrs,
          };
          row.push(cell);
          row.push(spacerCell());
          c += 2;
        } else {
          // Force narrow (replace wide at last col with space)
          row.push({
            char: (raw as any)._isWide ? " " : raw.char,
            width: 1,
            fg: raw.fg,
            bg: raw.bg,
            attrs: raw.attrs,
          });
          c += 1;
        }
      }
      // Trim or pad to exact cols
      cells.push(row.slice(0, cols));
    }

    return { cells, cursorRow, cursorCol, width: cols, height: rows };
  });
}

/** Variable-dimension grid arbitrary */
const variableGridArb: fc.Arbitrary<CellGrid> = fc
  .tuple(
    fc.integer({ min: 10, max: 120 }),
    fc.integer({ min: 5, max: 30 }),
  )
  .chain(([cols, rows]) => gridArb(cols, rows));

/** Two grids of the same dimensions */
const pairedGridArb: fc.Arbitrary<[CellGrid, CellGrid]> = fc
  .tuple(
    fc.integer({ min: 10, max: 80 }),
    fc.integer({ min: 5, max: 20 }),
  )
  .chain(([cols, rows]) =>
    fc.tuple(gridArb(cols, rows), gridArb(cols, rows)),
  );

/** Segment arbitrary: printable ASCII text, optional style */
const segmentArb: fc.Arbitrary<Segment> = fc.record({
  text: fc.array(
    fc.constantFrom(...NARROW_CHARS.filter((c) => c !== " ").concat([" "])),
    { minLength: 1, maxLength: 20 },
  ).map((chars) => chars.join("")),
  style: fc.option(
    fc.record({
      bold: fc.option(fc.boolean(), { nil: undefined }),
      italic: fc.option(fc.boolean(), { nil: undefined }),
      dim: fc.option(fc.boolean(), { nil: undefined }),
      fg: fc.option(
        fc.integer({ min: 0, max: 0xffffff }).map((v) => `#${v.toString(16).padStart(6, "0")}`),
        { nil: undefined },
      ),
    }),
    { nil: undefined },
  ),
});

/**
 * Generate a random TNode component tree suitable for layout+rasterize.
 * Root is a box(column), 3-8 children of text or nested boxes.
 */
const componentTreeArb: fc.Arbitrary<TNode> = fc
  .tuple(
    fc.integer({ min: 3, max: 8 }),
    fc.array(
      fc.oneof(
        // text child: 1-3 segments
        fc.array(segmentArb, { minLength: 1, maxLength: 3 }).map((segs) => ({
          kind: "text" as const,
          segments: segs,
        })),
        // box child with 1-3 text grandchildren + optional props
        fc
          .tuple(
            fc.array(fc.array(segmentArb, { minLength: 1, maxLength: 2 }), {
              minLength: 1,
              maxLength: 3,
            }),
            fc.integer({ min: 0, max: 3 }),  // paddingLeft
            fc.integer({ min: 0, max: 1 }),  // gap
            fc.option(fc.integer({ min: 20, max: 80 }), { nil: undefined }), // width
          )
          .map(([texts, paddingLeft, gap, width]) => ({
            kind: "box" as const,
            texts,
            paddingLeft,
            gap,
            width,
          })),
      ),
      { minLength: 3, maxLength: 8 },
    ),
  )
  .map(([_n, children]) => {
    const root = createNode("root", {});

    for (const child of children) {
      if (child.kind === "text") {
        const el = createNode("text", { segments: child.segments });
        const inst = createNode("text", {});
        inst.text = child.segments.map((s) => s.text).join("");
        appendChild(el, inst);
        appendChild(root, el);
      } else {
        const boxProps: Record<string, any> = { flexDirection: "column" };
        if (child.paddingLeft > 0) boxProps.paddingLeft = child.paddingLeft;
        if (child.gap > 0) boxProps.gap = child.gap;
        if (child.width != null) boxProps.width = child.width;
        const boxNode = createNode("box", boxProps);
        for (const segs of child.texts) {
          const el = createNode("text", { segments: segs });
          const inst = createNode("text", {});
          inst.text = segs.map((s) => s.text).join("");
          appendChild(el, inst);
          appendChild(boxNode, el);
        }
        appendChild(root, boxNode);
      }
    }

    return root;
  });

/**
 * Clone a TNode tree without structuredClone (TNodes have circular parent refs).
 * Returns a deep copy with same structure and props.
 */
function cloneTree(node: TNode, parent: TNode | null = null): TNode {
  const clone = createNode(node.type, { ...node.props });
  clone.text = node.text;
  for (const child of node.children) {
    const childClone = cloneTree(child, clone);
    appendChild(clone, childClone);
  }
  return clone;
}

/**
 * Collect all text-element nodes (type='text', has segments prop) from a tree.
 */
function collectTextNodes(root: TNode): TNode[] {
  const result: TNode[] = [];
  function walk(node: TNode) {
    if (node.type === "text" && node.props.segments != null) {
      result.push(node);
    }
    for (const child of node.children) walk(child);
  }
  walk(root);
  return result;
}

/**
 * Paired tree arbitrary: generate treeA, clone to treeB, mutate 1-3 text nodes in treeB.
 * Produces grids that are ~90% identical — the actual production workload.
 */
const mutatedTreeArb: fc.Arbitrary<{ treeA: TNode; treeB: TNode }> = fc
  .tuple(
    componentTreeArb,
    fc.array(segmentArb, { minLength: 1, maxLength: 3 }),
    fc.array(segmentArb, { minLength: 1, maxLength: 3 }),
    fc.array(segmentArb, { minLength: 1, maxLength: 3 }),
    fc.integer({ min: 1, max: 3 }),
    fc.integer({ min: 0, max: 99 }),
    fc.integer({ min: 0, max: 99 }),
    fc.integer({ min: 0, max: 99 }),
  )
  .map(([treeA, segs1, segs2, segs3, mutationCount, idx1, idx2, idx3]) => {
    const treeB = cloneTree(treeA);
    const textNodes = collectTextNodes(treeB);
    if (textNodes.length === 0) return { treeA, treeB };

    const replacements = [segs1, segs2, segs3].slice(0, mutationCount);
    const indices = [idx1, idx2, idx3].slice(0, mutationCount);

    for (let m = 0; m < replacements.length; m++) {
      const node = textNodes[indices[m]! % textNodes.length]!;
      const newSegs = replacements[m]!;
      node.props = { ...node.props, segments: newSegs };
      // Also update the text-instance child
      const inst = node.children.find((c) => c.text !== null);
      if (inst) inst.text = newSegs.map((s) => s.text).join("");
    }

    return { treeA, treeB };
  });

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("render property tests", () => {
  // ── Test 1: fullRedraw round-trip ──────────────────────────────────────
  test("1. fullRedraw round-trip", async () => {
    const seed = Date.now();
    console.log(`seed: ${seed}`);

    const samples = fc.sample(variableGridArb, { numRuns: 500, seed });

    for (let i = 0; i < samples.length; i++) {
      const grid = samples[i]!;
      const { cols, rows } = { cols: grid.width, rows: grid.height };
      const screen = new VirtualScreen(cols, rows);
      await screen.write(fullRedraw(grid, 0).output);
      const result = screen.readGrid();
      screen.dispose();
      assertGridsEqual(result, grid, "fullRedraw round-trip", seed, i, fullRedraw(grid, 0).output);
    }
  });

  // ── Test 2: diff round-trip ────────────────────────────────────────────
  test("2. diff round-trip", async () => {
    const seed = Date.now();
    console.log(`seed: ${seed}`);

    const samples = fc.sample(pairedGridArb, { numRuns: 500, seed });

    for (let i = 0; i < samples.length; i++) {
      const [gridA, gridB] = samples[i]!;
      const { width: cols, height: rows } = gridA;
      const d = diff(gridA, gridB, 0, 0);
      const result = await applyDiff(gridA, d.output, cols, rows);
      assertGridsEqual(result, gridB, "diff round-trip", seed, i, d.output);
    }
  });

  // ── Test 3: diff idempotency ───────────────────────────────────────────
  test("3. diff idempotency", async () => {
    const seed = Date.now();
    console.log(`seed: ${seed}`);

    const samples = fc.sample(variableGridArb, { numRuns: 300, seed });

    for (let i = 0; i < samples.length; i++) {
      const grid = samples[i]!;
      const d = diff(grid, grid, 0, 0);
      if (d.output !== "") {
        const hexOutput = Buffer.from(d.output).toString("hex");
        throw new Error(
          `[seed=${seed} iter=${i}] diff idempotency: diff(grid, grid) produced non-empty output\n` +
            `  output hex: ${hexOutput}\n` +
            `  output length: ${d.output.length}\n` +
            `  grid:\n${describeGrid(grid)}`,
        );
      }
    }
  });

  // ── Test 4: diff determinism ───────────────────────────────────────────
  test("4. diff determinism", async () => {
    const seed = Date.now();
    console.log(`seed: ${seed}`);

    const samples = fc.sample(pairedGridArb, { numRuns: 300, seed });

    for (let i = 0; i < samples.length; i++) {
      const [gridA, gridB] = samples[i]!;
      const d1 = diff(gridA, gridB, 0, 0);
      const d2 = diff(gridA, gridB, 0, 0);
      if (d1.output !== d2.output) {
        throw new Error(
          `[seed=${seed} iter=${i}] diff determinism: two calls produced different output\n` +
            `  output1 hex: ${Buffer.from(d1.output).toString("hex")}\n` +
            `  output2 hex: ${Buffer.from(d2.output).toString("hex")}\n` +
            `  gridA:\n${describeGrid(gridA)}\n` +
            `  gridB:\n${describeGrid(gridB)}`,
        );
      }
    }
  });

  // ── Test 5: sequential diff composition — 20 frames ───────────────────
  test("5. sequential diff composition — 20 frames", async () => {
    const seed = Date.now();
    console.log(`seed: ${seed}`);

    // Generate sets of 20 grids with fixed dimensions
    const frameSetArb: fc.Arbitrary<CellGrid[]> = fc
      .tuple(
        fc.integer({ min: 10, max: 60 }),
        fc.integer({ min: 5, max: 15 }),
      )
      .chain(([cols, rows]) =>
        fc.array(gridArb(cols, rows), { minLength: 20, maxLength: 20 }),
      );

    const samples = fc.sample(frameSetArb, { numRuns: 200, seed });

    for (let i = 0; i < samples.length; i++) {
      const grids = samples[i]!;
      const cols = grids[0]!.width;
      const rows = grids[0]!.height;

      // Sequential application screen
      const seqScreen = new VirtualScreen(cols, rows);
      await seqScreen.write(fullRedraw(grids[0]!, 0).output);

      for (let f = 1; f < grids.length; f++) {
        const d = diff(grids[f - 1]!, grids[f]!, 0, 0);
        // Reposition cursor to (0,0) before each diff (as frame-loop does with \x1b[H)
        await seqScreen.write(`\x1b[H`);
        if (d.output.length > 0) {
          await seqScreen.write(d.output);
        }
      }
      const seqResult = seqScreen.readGrid();
      seqScreen.dispose();

      // Direct fullRedraw of final frame
      const finalGrid = grids[grids.length - 1]!;
      const directScreen = new VirtualScreen(cols, rows);
      await directScreen.write(fullRedraw(finalGrid, 0).output);
      const directResult = directScreen.readGrid();
      directScreen.dispose();

      assertGridsEqual(
        seqResult,
        directResult,
        "sequential diff composition",
        seed,
        i,
        `(20-frame chain, last diff output not captured)`,
      );
    }
  });

  // ── Test 6: pending wrap stress ────────────────────────────────────────
  // NOTE: xterm-headless may be more lenient about pending wrap state than real
  // terminals (iTerm2, Ghostty, Windows Terminal). A passing test here does NOT
  // guarantee correct behavior on physical terminals. When implementing pending
  // wrap resolution (space+backspace), also test manually on a real terminal.
  test("6. pending wrap stress", async () => {
    const seed = Date.now();
    console.log(`seed: ${seed}`);

    // Targeted generator: last column differs, at least one other row also differs,
    // cursor position randomized.
    const wrapStressArb: fc.Arbitrary<[CellGrid, CellGrid]> = fc
      .tuple(
        fc.integer({ min: 10, max: 60 }),
        fc.integer({ min: 5, max: 15 }),
      )
      .chain(([cols, rows]) =>
        fc
          .tuple(
            gridArb(cols, rows),
            gridArb(cols, rows),
            fc.integer({ min: 0, max: rows - 1 }), // row with last-col diff
            fc.integer({ min: 0, max: rows - 1 }), // different row that also differs
            fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz".split("")),
            fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("")),
            fc.constantFrom(..."0123456789".split("")),
            fc.integer({ min: 0, max: rows - 1 }),
            fc.integer({ min: 0, max: cols - 2 }),
          )
          .map(([a, b, lastColRow, otherRow, charA, charB, charOther, cursorRow, cursorCol]) => {
            // Force last column of lastColRow to differ between A and B (ASCII narrow chars)
            const gridA: CellGrid = {
              ...a,
              cells: a.cells.map((row, r) => row.map((cell, c) => ({ ...cell }))),
              cursorRow: cursorRow % rows,
              cursorCol: cursorCol % (cols - 1),
            };
            const gridB: CellGrid = {
              ...b,
              cells: b.cells.map((row, r) => row.map((cell, c) => ({ ...cell }))),
              cursorRow: cursorRow % rows,
              cursorCol: cursorCol % (cols - 1),
            };

            const rowA = lastColRow % rows;
            // If cols-2 has a wide char, clear it — replacing cols-1 (the continuation
            // spacer) with a narrow char would create an invalid grid.
            for (const g of [gridA, gridB]) {
              if (cols >= 2 && g.cells[rowA]![cols - 2]!.width === 2) {
                g.cells[rowA]![cols - 2] = blankCell();
              }
            }
            gridA.cells[rowA]![cols - 1] = { ...blankCell(), char: charA };
            gridB.cells[rowA]![cols - 1] = { ...blankCell(), char: charB };

            // Force another row to also differ
            const rowOther = otherRow % rows;
            const colOther = Math.min(2, cols - 1);
            // Clear any wide char whose continuation would be at colOther, or whose
            // spacer at colOther+1 we'd orphan by replacing colOther.
            for (const g of [gridA, gridB]) {
              if (colOther > 0 && g.cells[rowOther]![colOther - 1]!.width === 2) {
                g.cells[rowOther]![colOther - 1] = blankCell();
              }
              if (colOther < cols - 1 && g.cells[rowOther]![colOther]!.width === 2) {
                g.cells[rowOther]![colOther + 1] = blankCell();
              }
            }
            gridA.cells[rowOther]![colOther] = { ...blankCell(), char: charOther };
            gridB.cells[rowOther]![colOther] = { ...blankCell(), char: "x" };

            return [gridA, gridB] as [CellGrid, CellGrid];
          }),
      );

    const samples = fc.sample(wrapStressArb, { numRuns: 300, seed });

    for (let i = 0; i < samples.length; i++) {
      const [gridA, gridB] = samples[i]!;
      const { width: cols, height: rows } = gridA;
      const d = diff(gridA, gridB, 0, 0);
      const result = await applyDiff(gridA, d.output, cols, rows);
      assertGridsEqual(result, gridB, "pending wrap stress", seed, i, d.output);
    }
  });

  // ── Test 7: wide chars at right edge ──────────────────────────────────
  test("7. wide chars at right edge", async () => {
    const seed = Date.now();
    console.log(`seed: ${seed}`);

    const wideEdgeArb: fc.Arbitrary<[CellGrid, CellGrid]> = fc
      .tuple(
        fc.integer({ min: 10, max: 60 }),
        fc.integer({ min: 5, max: 15 }),
      )
      .chain(([cols, rows]) =>
        fc
          .tuple(
            gridArb(cols, rows),
            gridArb(cols, rows),
            fc.integer({ min: 0, max: rows - 1 }),
            fc.constantFrom(...WIDE_CHARS),
            fc.constantFrom(...WIDE_CHARS),
            fc.constantFrom(0, 1, 2), // scenario: 0=wide→ascii, 1=ascii→wide, 2=wide→wide
          )
          .map(([a, b, targetRow, wideA, wideB, scenario]) => {
            const row = targetRow % rows;
            const wideCol = cols - 2; // last valid position for a wide char
            if (wideCol < 0) return [a, b] as [CellGrid, CellGrid];

            const gridA: CellGrid = {
              ...a,
              cells: a.cells.map((r) => r.map((c) => ({ ...c }))),
            };
            const gridB: CellGrid = {
              ...b,
              cells: b.cells.map((r) => r.map((c) => ({ ...c }))),
            };

            // Ensure wideCol is not a spacer from the preceding cell being wide.
            // If it is, clear wideCol-1 to avoid creating an invalid grid structure.
            for (const g of [gridA, gridB]) {
              if (wideCol > 0 && g.cells[row]![wideCol - 1]!.width === 2) {
                g.cells[row]![wideCol - 1] = blankCell();
              }
            }

            if (scenario === 0) {
              // wide in A → ascii in B
              gridA.cells[row]![wideCol] = {
                char: wideA,
                width: 2,
                fg: { mode: ColorMode.Default, value: 0 },
                bg: { mode: ColorMode.Default, value: 0 },
                attrs: 0,
              };
              gridA.cells[row]![wideCol + 1] = spacerCell();
              gridB.cells[row]![wideCol] = { ...blankCell(), char: "x" };
              gridB.cells[row]![wideCol + 1] = { ...blankCell(), char: "y" };
            } else if (scenario === 1) {
              // ascii in A → wide in B
              gridA.cells[row]![wideCol] = { ...blankCell(), char: "x" };
              gridA.cells[row]![wideCol + 1] = { ...blankCell(), char: "y" };
              gridB.cells[row]![wideCol] = {
                char: wideB,
                width: 2,
                fg: { mode: ColorMode.Default, value: 0 },
                bg: { mode: ColorMode.Default, value: 0 },
                attrs: 0,
              };
              gridB.cells[row]![wideCol + 1] = spacerCell();
            } else {
              // wide in A → different wide in B
              gridA.cells[row]![wideCol] = {
                char: wideA,
                width: 2,
                fg: { mode: ColorMode.Default, value: 0 },
                bg: { mode: ColorMode.Default, value: 0 },
                attrs: 0,
              };
              gridA.cells[row]![wideCol + 1] = spacerCell();
              gridB.cells[row]![wideCol] = {
                char: wideB,
                width: 2,
                fg: { mode: ColorMode.Default, value: 0 },
                bg: { mode: ColorMode.Default, value: 0 },
                attrs: 0,
              };
              gridB.cells[row]![wideCol + 1] = spacerCell();
            }

            return [gridA, gridB] as [CellGrid, CellGrid];
          }),
      );

    const samples = fc.sample(wideEdgeArb, { numRuns: 200, seed });

    for (let i = 0; i < samples.length; i++) {
      const [gridA, gridB] = samples[i]!;
      const { width: cols, height: rows } = gridA;

      // Test fullRedraw of both grids
      const screenA = new VirtualScreen(cols, rows);
      await screenA.write(fullRedraw(gridA, 0).output);
      const resultA = screenA.readGrid();
      screenA.dispose();
      assertGridsEqual(resultA, gridA, "wide edge fullRedraw A", seed, i, fullRedraw(gridA, 0).output);

      const screenB = new VirtualScreen(cols, rows);
      await screenB.write(fullRedraw(gridB, 0).output);
      const resultB = screenB.readGrid();
      screenB.dispose();
      assertGridsEqual(resultB, gridB, "wide edge fullRedraw B", seed, i, fullRedraw(gridB, 0).output);

      // Test diff A→B
      const d = diff(gridA, gridB, 0, 0);
      const diffResult = await applyDiff(gridA, d.output, cols, rows);
      assertGridsEqual(diffResult, gridB, "wide edge diff", seed, i, d.output);
    }
  });

  // ── Test 8: shrink simulation ──────────────────────────────────────────
  test("8. shrink simulation", async () => {
    const seed = Date.now();
    console.log(`seed: ${seed}`);

    const shrinkArb: fc.Arbitrary<[CellGrid, CellGrid]> = fc
      .tuple(
        fc.integer({ min: 10, max: 60 }),
        fc.integer({ min: 6, max: 15 }),
        fc.integer({ min: 1, max: 5 }),
      )
      .chain(([cols, rows, tailClear]) =>
        fc
          .tuple(
            gridArb(cols, rows),
            gridArb(cols, rows),
          )
          .map(([a, b]) => {
            const k = Math.min(tailClear, rows - 1);
            // Grid A: meaningful content everywhere (use a's cells as-is)
            const gridA: CellGrid = {
              ...a,
              cells: a.cells.map((r) => r.map((c) => ({ ...c }))),
            };

            // Grid B: tail rows (rows-k through rows-1) are blank,
            // content rows (0 through rows-k-1) differ from A
            const gridB: CellGrid = {
              ...b,
              cells: b.cells.map((r, ri) => {
                if (ri >= rows - k) {
                  // Tail rows: all blank
                  return r.map(() => blankCell());
                } else {
                  // Content rows: use b's cells (different from a)
                  return r.map((c) => ({ ...c }));
                }
              }),
            };

            return [gridA, gridB] as [CellGrid, CellGrid];
          }),
      );

    const samples = fc.sample(shrinkArb, { numRuns: 200, seed });

    for (let i = 0; i < samples.length; i++) {
      const [gridA, gridB] = samples[i]!;
      const { width: cols, height: rows } = gridA;
      const d = diff(gridA, gridB, 0, 0);
      const result = await applyDiff(gridA, d.output, cols, rows);
      assertGridsEqual(result, gridB, "shrink simulation", seed, i, d.output);
    }
  });

  // ── Test 9: cursor stays within viewport bounds ────────────────────────
  test("9. cursor stays within viewport bounds", async () => {
    const seed = Date.now();
    console.log(`seed: ${seed}`);

    const samples = fc.sample(pairedGridArb, { numRuns: 300, seed });

    for (let i = 0; i < samples.length; i++) {
      const [gridA, gridB] = samples[i]!;
      const { width: cols, height: rows } = gridA;
      const d = diff(gridA, gridB, 0, 0);

      const screen = new VirtualScreen(cols, rows);
      await screen.write(fullRedraw(gridA, 0).output);
      // Position cursor at (0,0) — matches diff(gridA, gridB, 0, 0) assumption
      await screen.write(`\x1b[H`);
      if (d.output.length > 0) {
        await screen.write(d.output);
      }

      const { row, col } = screen.getCursorPos();
      screen.dispose();

      // col <= cols is allowed: xterm-headless represents pending-wrap state
      // as cursorX = cols (one past the last column). This is normal terminal
      // behavior after writing to the rightmost column; the frame loop resets
      // cursor to (0,0) with \x1b[H before the next frame anyway.
      if (row < 0 || row >= rows || col < 0 || col > cols) {
        throw new Error(
          `[seed=${seed} iter=${i}] cursor out of bounds: row=${row} col=${col} ` +
            `viewport=${cols}x${rows}\n` +
            `  diff output hex: ${Buffer.from(d.output).toString("hex")}\n` +
            `  gridA cursor: (${gridA.cursorRow},${gridA.cursorCol})\n` +
            `  gridA:\n${describeGrid(gridA)}\n` +
            `  gridB:\n${describeGrid(gridB)}`,
        );
      }
    }
  });

  // ── Test 10: style-only transitions ───────────────────────────────────
  test("10. style-only transitions", async () => {
    const seed = Date.now();
    console.log(`seed: ${seed}`);

    // Generate grid pairs where characters are identical but styles differ
    const styleOnlyArb: fc.Arbitrary<[CellGrid, CellGrid]> = fc
      .tuple(
        fc.integer({ min: 10, max: 60 }),
        fc.integer({ min: 5, max: 15 }),
      )
      .chain(([cols, rows]) =>
        fc
          .tuple(
            gridArb(cols, rows),
            // Generate new fg/bg/attrs for 20-50% of cells
            fc.array(
              fc.tuple(
                fc.integer({ min: 0, max: rows - 1 }),
                fc.integer({ min: 0, max: cols - 1 }),
                colorArb,
                colorArb,
                fc.integer({ min: 0, max: 7 }),
              ),
              { minLength: Math.ceil(cols * rows * 0.2), maxLength: Math.ceil(cols * rows * 0.5) },
            ),
          )
          .map(([base, mutations]) => {
            const gridA: CellGrid = {
              ...base,
              cells: base.cells.map((r) => r.map((c) => ({ ...c }))),
            };
            const gridB: CellGrid = {
              ...base,
              cells: base.cells.map((r) => r.map((c) => ({ ...c }))),
            };

            // Apply style mutations to gridB only (keep chars identical)
            for (const [r, c, fg, bg, attrs] of mutations) {
              const row = r % rows;
              const col = c % cols;
              const cellA = gridA.cells[row]![col]!;
              // Only mutate narrow cells (skip spacers and wide chars for simplicity)
              if (cellA.width === 1 && cellA.char !== "") {
                gridB.cells[row]![col] = {
                  ...gridB.cells[row]![col]!,
                  fg,
                  bg,
                  attrs,
                };
              }
            }

            return [gridA, gridB] as [CellGrid, CellGrid];
          }),
      );

    const samples = fc.sample(styleOnlyArb, { numRuns: 300, seed });

    for (let i = 0; i < samples.length; i++) {
      const [gridA, gridB] = samples[i]!;
      const { width: cols, height: rows } = gridA;
      const d = diff(gridA, gridB, 0, 0);
      const result = await applyDiff(gridA, d.output, cols, rows);
      assertGridsEqual(result, gridB, "style-only transitions", seed, i, d.output);
    }
  });

  // ── Test 11: diff minimality ───────────────────────────────────────────
  test("11. diff minimality", async () => {
    const seed = Date.now();
    console.log(`seed: ${seed}`);

    // Generate pairs where only 1-5 cells differ
    const sparseChangeArb: fc.Arbitrary<[CellGrid, CellGrid]> = fc
      .tuple(
        fc.integer({ min: 10, max: 60 }),
        fc.integer({ min: 5, max: 15 }),
      )
      .chain(([cols, rows]) =>
        fc
          .tuple(
            gridArb(cols, rows),
            fc.integer({ min: 1, max: 5 }),
            fc.array(
              fc.tuple(
                fc.integer({ min: 0, max: rows - 1 }),
                fc.integer({ min: 0, max: cols - 1 }),
                fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz".split("")),
                colorArb,
                fc.integer({ min: 0, max: 7 }),
              ),
              { minLength: 5, maxLength: 5 },
            ),
          )
          .map(([base, changeCount, changes]) => {
            const gridA: CellGrid = {
              ...base,
              cells: base.cells.map((r) => r.map((c) => ({ ...c }))),
            };
            const gridB: CellGrid = {
              ...base,
              cells: base.cells.map((r) => r.map((c) => ({ ...c }))),
            };

            // Apply only 'changeCount' changes
            let applied = 0;
            for (const [r, c, ch, fg, attrs] of changes) {
              if (applied >= changeCount) break;
              const row = r % rows;
              const col = c % cols;
              const cellA = gridA.cells[row]![col]!;
              // Skip spacers and wide chars
              if (cellA.width !== 1 || cellA.char === "") continue;
              gridB.cells[row]![col] = {
                char: ch,
                width: 1,
                fg,
                bg: { mode: ColorMode.Default, value: 0 },
                attrs,
              };
              applied++;
            }

            return [gridA, gridB] as [CellGrid, CellGrid];
          }),
      );

    const samples = fc.sample(sparseChangeArb, { numRuns: 200, seed });

    for (let i = 0; i < samples.length; i++) {
      const [gridA, gridB] = samples[i]!;
      const d = diff(gridA, gridB, 0, 0);
      const fr = fullRedraw(gridB, 0);

      // For grids large enough that the comparison is meaningful (fullRedraw > 500 bytes),
      // assert that a 1-5 cell diff is < 75% of fullRedraw size. For tiny grids, cursor
      // movement overhead is proportionally high and the 75% threshold may still be
      // exceeded — that's expected, not a bug in the diff engine. The real failure mode
      // this test catches is: diff producing full-grid output (100%+ of fullRedraw) for
      // a trivial change.
      const isLargeEnough = fr.output.length > 500;
      if (isLargeEnough && d.output.length >= fr.output.length * 0.75) {
        throw new Error(
          `[seed=${seed} iter=${i}] diff minimality: diff output too large\n` +
            `  diff length: ${d.output.length}\n` +
            `  fullRedraw length: ${fr.output.length}\n` +
            `  ratio: ${(d.output.length / fr.output.length).toFixed(3)}\n` +
            `  gridA:\n${describeGrid(gridA)}\n` +
            `  gridB:\n${describeGrid(gridB)}\n` +
            `  diff hex: ${Buffer.from(d.output).toString("hex")}`,
        );
      }
    }
  });

  // ── Test 12: full pipeline: component → rasterize → diff → verify ─────
  test("12. full pipeline: component → rasterize → diff → verify", async () => {
    const seed = Date.now();
    console.log(`seed: ${seed}`);

    // cols: 40-120, rows: 10-30
    const pipelineArb: fc.Arbitrary<{
      treeA: TNode;
      treeB: TNode;
      cols: number;
      rows: number;
    }> = fc
      .tuple(
        mutatedTreeArb,
        fc.integer({ min: 40, max: 120 }),
        fc.integer({ min: 10, max: 30 }),
      )
      .map(([{ treeA, treeB }, cols, rows]) => ({ treeA, treeB, cols, rows }));

    const samples = fc.sample(pipelineArb, { numRuns: 300, seed });

    for (let i = 0; i < samples.length; i++) {
      const { treeA, treeB, cols, rows } = samples[i]!;

      // Rasterize both trees
      layout(treeA, cols, rows);
      const gridA = rasterize(treeA, cols, rows, 0);

      layout(treeB, cols, rows);
      const gridB = rasterize(treeB, cols, rows, 0);

      // Apply diff from A to B
      const d = diff(gridA, gridB, 0, 0);
      const diffScreen = new VirtualScreen(cols, rows);
      await diffScreen.write(fullRedraw(gridA, 0).output);
      await diffScreen.write(`\x1b[H`);
      if (d.output.length > 0) {
        await diffScreen.write(d.output);
      }
      const resultGrid = diffScreen.readGrid();
      diffScreen.dispose();

      // Direct fullRedraw of B
      const directScreen = new VirtualScreen(cols, rows);
      await directScreen.write(fullRedraw(gridB, 0).output);
      const directGrid = directScreen.readGrid();
      directScreen.dispose();

      // Both should match gridB
      assertGridsEqual(
        resultGrid,
        gridB,
        "pipeline: diff result vs expected gridB",
        seed,
        i,
        d.output,
      );
      assertGridsEqual(
        resultGrid,
        directGrid,
        "pipeline: diff result vs direct fullRedraw",
        seed,
        i,
        d.output,
      );
    }
  });
});
