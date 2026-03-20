import { describe, test, expect } from "bun:test";
import React, { useState, useEffect } from "react";
import { render, Text, Box } from "ink";
import { Writable } from "node:stream";
import { VirtualScreen } from "../virtual-screen.js";
import { diff, fullRedraw } from "../../src/diff.js";
import { gridToDebugString, cellsEqual, type CellGrid } from "../../src/cell.js";

/**
 * Create a fake TTY writable stream that captures all output chunks.
 */
function createCaptureStream(cols = 80, rows = 24) {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      cb();
    },
  });
  Object.defineProperty(stream, "columns", { get: () => cols });
  Object.defineProperty(stream, "rows", { get: () => rows });
  Object.defineProperty(stream, "isTTY", { get: () => true });
  return { stream: stream as any, chunks };
}

/**
 * Wait for Ink to finish rendering a frame.
 */
function waitFrame(ms = 150): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Wait until new chunks appear in the capture array, with a timeout.
 * Returns once at least one new chunk has appeared and no more arrive
 * within a short settle window.
 */
async function waitForOutput(
  chunks: string[],
  fromIndex = 0,
  timeoutMs = 2000,
  settleMs = 100
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // Wait for at least one new chunk
  while (chunks.length <= fromIndex && Date.now() < deadline) {
    await waitFrame(20);
  }
  // Let output settle — wait until no new chunks arrive
  let prev = chunks.length;
  while (Date.now() < deadline) {
    await waitFrame(settleMs);
    if (chunks.length === prev) break;
    prev = chunks.length;
  }
}

/**
 * Concatenate all captured chunks into a single string.
 */
function joinChunks(chunks: string[], from = 0): string {
  return chunks.slice(from).join("");
}

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

describe("DEC 2026 and cursor visibility sequences", () => {
  test("xterm-headless ignores DEC 2026 synchronized output sequences", async () => {
    const screen = new VirtualScreen(80, 24);
    await screen.write("\x1b[?2026hhello world\x1b[?2026l");
    const grid = screen.readGrid();
    screen.dispose();

    const line = gridToDebugString(grid).split("\n")[0];
    expect(line).toBe("hello world");
    // Verify no garbage characters leaked into any cell
    for (let c = 0; c < grid.width; c++) {
      const ch = grid.cells[0][c].char;
      expect(ch === " " || "hello world".includes(ch)).toBe(true);
    }
  });

  test("xterm-headless ignores cursor hide/show sequences", async () => {
    const screen = new VirtualScreen(80, 24);
    await screen.write("\x1b[?25lsome text\x1b[?25h");
    const grid = screen.readGrid();
    screen.dispose();

    const line = gridToDebugString(grid).split("\n")[0];
    expect(line).toBe("some text");
  });

  test("xterm-headless handles a real Ink-like frame with DEC 2026 + cursor hide + content", async () => {
    // Simulate a real Ink frame: DEC 2026 begin, cursor hide, erase + content, cursor show, DEC 2026 end
    const frame =
      "\x1b[?2026h" + // synchronized output begin
      "\x1b[?25l" + // cursor hide
      "\x1b[1;1H" + // cursor home
      "\x1b[0m" + // reset style
      "Hello from Ink" +
      "\x1b[?25h" + // cursor show
      "\x1b[?2026l"; // synchronized output end

    const screen = new VirtualScreen(80, 24);
    await screen.write(frame);
    const grid = screen.readGrid();
    screen.dispose();

    const line = gridToDebugString(grid).split("\n")[0];
    expect(line).toBe("Hello from Ink");
  });

  test("real Ink render output with DEC 2026 produces clean grid", async () => {
    const { stream, chunks } = createCaptureStream(80, 24);
    const { unmount } = render(
      React.createElement(Text, null, "DEC2026 test"),
      { stdout: stream, stdin: process.stdin, patchConsole: false, exitOnCtrlC: false }
    );

    await waitFrame();
    unmount();
    await waitFrame(50);

    const raw = joinChunks(chunks);
    // Verify Ink actually emitted DEC 2026 sequences (since stream.isTTY = true)
    const hasDec2026 = raw.includes("\x1b[?2026h") || raw.includes("\x1b[?2026l");
    console.log("Ink emitted DEC 2026:", hasDec2026);

    const screen = new VirtualScreen(80, 24);
    await screen.write(raw);
    const grid = screen.readGrid();
    screen.dispose();

    const line = gridToDebugString(grid).split("\n")[0];
    expect(line).toContain("DEC2026 test");
    // No control chars in the visible text
    expect(line).not.toMatch(/[\x00-\x1f]/);
  });
});

describe("Ink output capture", () => {
  test("capture simple render and parse through VirtualScreen", async () => {
    const { stream, chunks } = createCaptureStream(80, 24);
    const { unmount } = render(
      React.createElement(Text, null, "hello world"),
      { stdout: stream, stdin: process.stdin, patchConsole: false, exitOnCtrlC: false }
    );

    await waitFrame();
    unmount();
    await waitFrame(50);

    const raw = joinChunks(chunks);
    console.log("Frame 1 raw:", JSON.stringify(raw));

    // Feed to VirtualScreen and verify
    const screen = new VirtualScreen(80, 24);
    await screen.write(raw);
    const grid = screen.readGrid();
    screen.dispose();

    const debug = gridToDebugString(grid);
    expect(debug.split("\n")[0]).toContain("hello world");
  });

  test("capture incremental update: hello → world", async () => {
    const { stream, chunks } = createCaptureStream(80, 24);

    let updateFn: ((s: string) => void) | null = null;
    function App() {
      const [text, setText] = useState("hello");
      useEffect(() => { updateFn = setText; }, []);
      return React.createElement(Text, null, text);
    }

    const { unmount } = render(React.createElement(App), {
      stdout: stream, stdin: process.stdin, patchConsole: false, exitOnCtrlC: false,
    });

    await waitFrame();
    const frame1End = chunks.length;
    const frame1Raw = joinChunks(chunks);
    console.log("Frame 1 raw:", JSON.stringify(frame1Raw));

    // Trigger state update
    updateFn!("world");
    await waitFrame();
    unmount();
    await waitFrame(50);

    const frame2Raw = joinChunks(chunks, frame1End);
    console.log("Frame 2 raw:", JSON.stringify(frame2Raw));

    // Feed both frames to a single VirtualScreen
    const screen = new VirtualScreen(80, 24);
    await screen.write(frame1Raw);
    await screen.write(frame2Raw);
    const grid = screen.readGrid();
    screen.dispose();

    const line0 = gridToDebugString(grid).split("\n")[0];
    expect(line0).toContain("world");
    expect(line0).not.toContain("hello");
  });

  test("capture multi-line update: change only middle line", async () => {
    const { stream, chunks } = createCaptureStream(80, 24);

    let updateFn: ((s: string) => void) | null = null;
    function App() {
      const [mid, setMid] = useState("line 2");
      useEffect(() => { updateFn = setMid; }, []);
      return React.createElement(
        Box,
        { flexDirection: "column" },
        React.createElement(Text, null, "line 1"),
        React.createElement(Text, null, mid),
        React.createElement(Text, null, "line 3")
      );
    }

    const { unmount } = render(React.createElement(App), {
      stdout: stream, stdin: process.stdin, patchConsole: false, exitOnCtrlC: false,
    });

    await waitFrame();
    const frame1End = chunks.length;
    const frame1Raw = joinChunks(chunks);
    console.log("Frame 1 raw:", JSON.stringify(frame1Raw));

    updateFn!("CHANGED");
    await waitFrame();
    unmount();
    await waitFrame(50);

    const frame2Raw = joinChunks(chunks, frame1End);
    console.log("Frame 2 raw:", JSON.stringify(frame2Raw));

    // Feed both frames to VirtualScreen
    const screen = new VirtualScreen(80, 24);
    await screen.write(frame1Raw);
    await screen.write(frame2Raw);
    const grid = screen.readGrid();
    screen.dispose();

    const lines = gridToDebugString(grid).split("\n");
    expect(lines[0]).toBe("line 1");
    expect(lines[1]).toBe("CHANGED");
    expect(lines[2]).toBe("line 3");
  });

  test("two-frame diff pipeline: capture frames, diff grids, apply to fresh screen", async () => {
    const { stream, chunks } = createCaptureStream(80, 24);

    let updateFn: ((s: string) => void) | null = null;
    function App() {
      const [label, setLabel] = useState("initial");
      useEffect(() => { updateFn = setLabel; }, []);
      return React.createElement(
        Box,
        { flexDirection: "column" },
        React.createElement(Text, null, "Header: stable"),
        React.createElement(Text, { bold: true }, `Content: ${label}`),
        React.createElement(Text, { color: "green" }, "Footer: stable")
      );
    }

    const { unmount } = render(React.createElement(App), {
      stdout: stream, stdin: process.stdin, patchConsole: false, exitOnCtrlC: false,
    });

    // Frame 1
    await waitForOutput(chunks);
    const frame1End = chunks.length;
    const frame1Raw = joinChunks(chunks);

    const screenA = new VirtualScreen(80, 24);
    await screenA.write(frame1Raw);
    const grid1 = screenA.readGrid();
    screenA.dispose();

    // Frame 2 — update content
    updateFn!("updated");
    await waitForOutput(chunks, frame1End);
    unmount();
    await waitFrame(50);

    const frame2Raw = joinChunks(chunks, frame1End);

    const screenB = new VirtualScreen(80, 24);
    await screenB.write(frame1Raw);
    await screenB.write(frame2Raw);
    const grid2 = screenB.readGrid();
    screenB.dispose();

    // Verify grids have expected content
    const lines1 = gridToDebugString(grid1).split("\n");
    expect(lines1[0]).toContain("Header: stable");
    expect(lines1[1]).toContain("Content: initial");
    expect(lines1[2]).toContain("Footer: stable");

    const lines2 = gridToDebugString(grid2).split("\n");
    expect(lines2[0]).toContain("Header: stable");
    expect(lines2[1]).toContain("Content: updated");
    expect(lines2[2]).toContain("Footer: stable");

    // Diff grid1 → grid2
    const d = diff(grid1, grid2);
    expect(d.output.length).toBeGreaterThan(0);

    // Apply: seed a fresh VirtualScreen with grid1 via fullRedraw, then apply diff
    const screenC = new VirtualScreen(80, 24);
    await screenC.write(fullRedraw(grid1).output);
    // Position cursor where diff() assumes it starts
    await screenC.write(`\x1b[${grid1.cursorRow + 1};${grid1.cursorCol + 1}H`);
    await screenC.write(d.output);
    const result = screenC.readGrid();
    screenC.dispose();

    // Result must match grid2 cell-for-cell
    assertGridsEqual(result, grid2);

    // Double-check text content
    const resultLines = gridToDebugString(result).split("\n");
    expect(resultLines[0]).toContain("Header: stable");
    expect(resultLines[1]).toContain("Content: updated");
    expect(resultLines[2]).toContain("Footer: stable");
  });

  test("full pipeline: capture → VirtualScreen → diff → apply", async () => {
    const { stream, chunks } = createCaptureStream(80, 24);

    let updateFn: ((s: string) => void) | null = null;
    function App() {
      const [status, setStatus] = useState("idle");
      useEffect(() => { updateFn = setStatus; }, []);
      return React.createElement(
        Box,
        { flexDirection: "column" },
        React.createElement(Text, null, "Message 1: Hello"),
        React.createElement(Text, null, "Message 2: World"),
        React.createElement(Text, { dimColor: true }, `Status: ${status}`)
      );
    }

    const { unmount } = render(React.createElement(App), {
      stdout: stream, stdin: process.stdin, patchConsole: false, exitOnCtrlC: false,
    });

    // Frame 1
    await waitFrame();
    const frame1End = chunks.length;
    const frame1Raw = joinChunks(chunks);

    const screen1 = new VirtualScreen(80, 24);
    await screen1.write(frame1Raw);
    const grid1 = screen1.readGrid();
    screen1.dispose();

    // Frame 2 — change status
    updateFn!("thinking...");
    await waitFrame();
    unmount();
    await waitFrame(50);

    const frame2Raw = joinChunks(chunks, frame1End);

    const screen2 = new VirtualScreen(80, 24);
    await screen2.write(frame1Raw);
    await screen2.write(frame2Raw);
    const grid2 = screen2.readGrid();
    screen2.dispose();

    // Now run the diff pipeline: diff(grid1, grid2)
    const d = diff(grid1, grid2);
    expect(d.output.length).toBeGreaterThan(0);

    // Apply diff to a fresh VirtualScreen seeded with grid1
    const screen3 = new VirtualScreen(80, 24);
    await screen3.write(fullRedraw(grid1).output);
    await screen3.write(`\x1b[${grid1.cursorRow + 1};${grid1.cursorCol + 1}H`);
    await screen3.write(d.output);
    const result = screen3.readGrid();
    screen3.dispose();

    // Result should match grid2
    assertGridsEqual(result, grid2);

    // Verify content
    const lines = gridToDebugString(grid2).split("\n");
    expect(lines[0]).toContain("Message 1");
    expect(lines[2]).toContain("thinking...");
  });

  test("write-count diagnostic: how many write() calls per Ink frame", async () => {
    const writes: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        writes.push(typeof chunk === "string" ? chunk : chunk.toString());
        cb();
      },
    });
    Object.defineProperty(stream, "columns", { get: () => 80 });
    Object.defineProperty(stream, "rows", { get: () => 24 });
    Object.defineProperty(stream, "isTTY", { get: () => true });

    let updateFn: ((s: string) => void) | null = null;
    function App() {
      const [label, setLabel] = useState("initial");
      useEffect(() => { updateFn = setLabel; }, []);
      return React.createElement(
        Box,
        { flexDirection: "column" },
        React.createElement(Text, null, "Header line"),
        React.createElement(Text, { bold: true }, `Content: ${label}`),
        React.createElement(Text, { color: "green" }, "Footer line")
      );
    }

    const { unmount } = render(React.createElement(App), {
      stdout: stream as any, stdin: process.stdin, patchConsole: false, exitOnCtrlC: false,
    });

    // Frame 1 — initial render
    await waitForOutput(writes);
    const frame1Writes = writes.length;
    console.log(`\nInitial render: ${frame1Writes} write() calls`);
    for (let i = 0; i < writes.length; i++) {
      console.log(`  write[${i}]: ${JSON.stringify(writes[i])}`);
    }

    // Frame 2 — state update
    const frame2Start = writes.length;
    updateFn!("updated");
    await waitForOutput(writes, frame2Start);

    const frame2Writes = writes.length - frame2Start;
    console.log(`Update render: ${frame2Writes} write() calls`);
    for (let i = frame2Start; i < writes.length; i++) {
      console.log(`  write[${i - frame2Start}]: ${JSON.stringify(writes[i])}`);
    }

    unmount();
    await waitFrame(50);

    // Just verify the test ran — the diagnostic output is what matters
    expect(frame1Writes).toBeGreaterThan(0);
    expect(frame2Writes).toBeGreaterThan(0);
  });
});
