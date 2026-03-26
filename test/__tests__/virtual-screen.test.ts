import { describe, test, expect, afterEach } from "bun:test";
import { VirtualScreen } from "../virtual-screen.js";
import { gridToDebugString, ColorMode } from "../../src/cell.js";
import { renderOnce } from "../../src/tui/render-once.js";
import { markdownToElements } from "../../src/tui/markdown.js";

describe("VirtualScreen", () => {
  let screen: VirtualScreen;

  afterEach(() => {
    screen?.dispose();
  });

  test("basic accumulation: overwrite with cursor-home", async () => {
    screen = new VirtualScreen(80, 24);
    await screen.write("hello");
    // Move cursor to row 1, col 1 (1-based) and overwrite
    await screen.write("\x1b[1;1Hworld");

    const grid = screen.readGrid();
    const row0 = grid.cells[0].slice(0, 5).map((c) => c.char);
    expect(row0).toEqual(["w", "o", "r", "l", "d"]);
  });

  test("incremental updates preserve unchanged cells", async () => {
    screen = new VirtualScreen(80, 24);
    await screen.write("line1\r\nline2\r\nline3");

    // Move to row 2 (1-based), erase that line, write new content
    await screen.write("\x1b[2;1H\x1b[2KCHANGED");

    const debug = gridToDebugString(screen.readGrid());
    const lines = debug.split("\n");
    expect(lines[0]).toBe("line1");
    expect(lines[1]).toBe("CHANGED");
    expect(lines[2]).toBe("line3");
  });

  test("styled frames: partial rewrite preserves other lines", async () => {
    screen = new VirtualScreen(80, 24);

    // Frame 1: three styled lines using raw ANSI
    // Bold red "Header Line", green "Middle content here", blue italic "Footer info"
    const frame1 =
      "\x1b[1;31mHeader Line\x1b[0m" +
      "\r\n" +
      "\x1b[32mMiddle content here\x1b[0m" +
      "\r\n" +
      "\x1b[3;34mFooter info\x1b[0m";
    await screen.write(frame1);

    // Read and snapshot lines 0 and 2
    const grid1 = screen.readGrid();
    const row0Before = grid1.cells[0].slice(0, 11); // "Header Line"
    const row2Before = grid1.cells[2].slice(0, 11); // "Footer info"

    // Verify line 0 has bold + red (palette color 1)
    expect(row0Before[0].fg.mode).toBe(ColorMode.Palette);
    expect(row0Before[0].attrs & 1).toBe(1); // bold

    // Frame 2: only rewrite line 2 (row index 1, 1-based = row 2)
    await screen.write("\x1b[2;1H\x1b[2K\x1b[33mUpdated middle\x1b[0m");

    const grid2 = screen.readGrid();

    // Row 0 unchanged
    const row0After = grid2.cells[0].slice(0, 11);
    for (let i = 0; i < 11; i++) {
      expect(row0After[i].char).toBe(row0Before[i].char);
      expect(row0After[i].fg.mode).toBe(row0Before[i].fg.mode);
      expect(row0After[i].fg.value).toBe(row0Before[i].fg.value);
      expect(row0After[i].attrs).toBe(row0Before[i].attrs);
    }

    // Row 2 unchanged
    const row2After = grid2.cells[2].slice(0, 11);
    for (let i = 0; i < 11; i++) {
      expect(row2After[i].char).toBe(row2Before[i].char);
      expect(row2After[i].fg.mode).toBe(row2Before[i].fg.mode);
      expect(row2After[i].fg.value).toBe(row2Before[i].fg.value);
      expect(row2After[i].attrs).toBe(row2Before[i].attrs);
    }

    // Row 1 has new content
    const debug = gridToDebugString(grid2);
    expect(debug.split("\n")[1]).toBe("Updated middle");
  });

  test("multiple rapid writes: 10 sequential chunks, read once", async () => {
    screen = new VirtualScreen(40, 10);

    for (let i = 0; i < 10; i++) {
      // Each write moves cursor to row i+1 (1-based) and writes
      await screen.write(`\x1b[${i + 1};1Hline-${i}`);
    }

    const grid = screen.readGrid();
    const debug = gridToDebugString(grid);
    const lines = debug.split("\n");
    for (let i = 0; i < 10; i++) {
      expect(lines[i]).toBe(`line-${i}`);
    }
  });

  test("resize: returns grid at new dimensions", async () => {
    screen = new VirtualScreen(80, 24);
    await screen.write("some content here");

    screen.resize(40, 10);
    const grid = screen.readGrid();

    expect(grid.width).toBe(40);
    expect(grid.height).toBe(10);
    expect(grid.cells.length).toBe(10);
    expect(grid.cells[0].length).toBe(40);
    // Content is lost after resize — row 0 should be all spaces
    const row0HasContent = grid.cells[0].some(
      (c) => c.char !== " " && c.char !== ""
    );
    expect(row0HasContent).toBe(false);
  });

  test("integration with CellState renderOnce", async () => {
    screen = new VirtualScreen(80, 60);

    const md1 = [
      "# First heading",
      "",
      "Some **bold** and `code`.",
      "",
      "```js",
      "const a = 1;",
      "```",
    ].join("\n");

    const ansi1 = await renderOnce(markdownToElements(md1), { columns: 80 });
    await screen.write(ansi1);

    const grid1 = screen.readGrid();
    let nonEmpty1 = 0;
    for (const row of grid1.cells) {
      for (const cell of row) {
        if (cell.char !== "") nonEmpty1++;
      }
    }
    expect(nonEmpty1).toBeGreaterThan(0);

    const text1 = gridToDebugString(grid1);
    expect(text1).toContain("First");

    // Write a second markdown with cursor-home prefix to overwrite
    const md2 = [
      "# Second heading",
      "",
      "Different content with a list:",
      "",
      "- alpha",
      "- beta",
    ].join("\n");

    const ansi2 = await renderOnce(markdownToElements(md2), { columns: 80 });
    // Cursor home + erase screen, then new content
    await screen.write("\x1b[H\x1b[2J" + ansi2);

    const grid2 = screen.readGrid();
    const text2 = gridToDebugString(grid2);
    expect(text2).toContain("Second");
    expect(text2).toContain("alpha");
    // Old content should be gone
    expect(text2).not.toContain("First");
  });
});
