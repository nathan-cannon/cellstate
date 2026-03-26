/**
 * VerifiedFrameLoop: test helper that wraps createFrameLoop with a stdout
 * stream that both captures output AND feeds it to a VirtualScreen (xterm.js).
 *
 * After each frame, callers can compare loop.getGrid() (what CellState thinks
 * the terminal looks like) against virtualScreen.readViewportGrid() (what
 * xterm.js actually rendered) to verify visual correctness.
 */
import { EventEmitter } from 'node:events';
import { createFrameLoop, type FrameLoop } from '../../src/tui/frame-loop.js';
import { VirtualScreen } from '../virtual-screen.js';
import {
  cellsEqual,
  gridToDebugString,
  ColorMode,
  Attr,
  type CellGrid,
} from '../../src/cell.js';

// ─── Verified stdout stream ─────────────────────────────────────────────────

export interface VerifiedStdout extends NodeJS.WriteStream {
  written: string[];
  columns: number;
  rows: number;
}

function createVerifiedStdout(
  cols: number,
  rows: number,
  onWrite: (chunk: string) => void,
): VerifiedStdout {
  const emitter = new EventEmitter();
  const written: string[] = [];

  const mock = Object.assign(emitter, {
    written,
    columns: cols,
    rows,
    writable: true,
    write(chunk: any, ...args: any[]): boolean {
      const str = typeof chunk === 'string' ? chunk : chunk.toString();
      written.push(str);
      onWrite(str);
      return true;
    },
    end: () => mock,
    destroy: () => mock,
    cork: () => {},
    uncork: () => {},
    isTTY: true,
    fd: 1,
    close: () => {},
    bytesWritten: 0,
    path: '',
    pending: false,
    addListener: emitter.addListener.bind(emitter),
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    removeListener: emitter.removeListener.bind(emitter),
    off: emitter.off.bind(emitter),
    removeAllListeners: emitter.removeAllListeners.bind(emitter),
    setMaxListeners: emitter.setMaxListeners.bind(emitter),
    getMaxListeners: emitter.getMaxListeners.bind(emitter),
    listeners: emitter.listeners.bind(emitter),
    rawListeners: emitter.rawListeners.bind(emitter),
    emit: emitter.emit.bind(emitter),
    listenerCount: emitter.listenerCount.bind(emitter),
    prependListener: emitter.prependListener.bind(emitter),
    prependOnceListener: emitter.prependOnceListener.bind(emitter),
    eventNames: emitter.eventNames.bind(emitter),
  }) as any as VerifiedStdout;

  return mock;
}

// ─── Grid comparison ────────────────────────────────────────────────────────

function describeGrid(grid: CellGrid): string {
  const lines: string[] = [];
  for (let r = 0; r < grid.height; r++) {
    const row = grid.cells[r]!;
    const chars = row.map((c) => (c.char === '' ? ' ' : c.char)).join('');
    lines.push(`row ${r}: "${chars.trimEnd()}"`);

    const annotations: string[] = [];
    for (let c = 0; c < row.length; c++) {
      const cell = row[c]!;
      const parts: string[] = [];
      if (cell.width === 2) parts.push('w2');
      if (cell.attrs & Attr.Bold) parts.push('B');
      if (cell.attrs & Attr.Italic) parts.push('I');
      if (cell.attrs & Attr.Underline) parts.push('U');
      if (cell.attrs & Attr.Dim) parts.push('D');
      if (cell.fg.mode === ColorMode.Palette) parts.push(`P${cell.fg.value}`);
      if (cell.fg.mode === ColorMode.RGB)
        parts.push(`#${cell.fg.value.toString(16).padStart(6, '0')}`);
      if (cell.bg.mode === ColorMode.Palette) parts.push(`BG${cell.bg.value}`);
      if (cell.bg.mode === ColorMode.RGB)
        parts.push(`BG#${cell.bg.value.toString(16).padStart(6, '0')}`);
      if (parts.length > 0) annotations.push(`[${c}:${parts.join(',')}]`);
    }
    if (annotations.length > 0) {
      lines.push('      ' + annotations.join(' '));
    }
  }
  return lines.join('\n');
}

/**
 * Compare two grids cell-by-cell for visual correctness.
 * Skips spacer cells (width=0, char="") — their attrs are terminal-inherited.
 */
export function assertGridsMatch(
  actual: CellGrid,
  expected: CellGrid,
  label: string,
  context?: string,
): void {
  if (actual.width !== expected.width || actual.height !== expected.height) {
    throw new Error(
      `${label}: dimension mismatch ` +
        `actual=${actual.width}x${actual.height} expected=${expected.width}x${expected.height}` +
        (context ? `\n${context}` : ''),
    );
  }
  for (let r = 0; r < expected.height; r++) {
    for (let c = 0; c < expected.width; c++) {
      const a = actual.cells[r]![c]!;
      const e = expected.cells[r]![c]!;
      // Skip spacer cells — their attrs are inherited by the terminal
      if (e.width === 0 && e.char === '' && a.width === 0 && a.char === '') continue;
      if (!cellsEqual(a, e)) {
        throw new Error(
          `${label}: cell mismatch at (row=${r},col=${c})\n` +
            `  actual:   ${JSON.stringify(a)}\n` +
            `  expected: ${JSON.stringify(e)}\n` +
            `  grid dimensions: ${expected.width}x${expected.height}\n` +
            (context ? `  ${context}\n` : '') +
            `  actual grid:\n${describeGrid(actual)}\n` +
            `  expected grid:\n${describeGrid(expected)}`,
        );
      }
    }
  }
}

// ─── VerifiedFrameLoop ──────────────────────────────────────────────────────

export interface VerifiedFrameLoopInstance {
  /** The underlying FrameLoop */
  loop: FrameLoop;
  /** The mock stdout stream (exposes columns/rows for resize) */
  stdout: VerifiedStdout;
  /** Flush all pending writes to xterm.js and wait for React to settle */
  flush: () => Promise<void>;
  /**
   * Assert CellState's viewport grid matches xterm.js's viewport grid.
   * Call after flush().
   */
  assertFrameCorrect: (label?: string) => void;
  /** Read xterm.js's viewport grid (what a user would see) */
  readViewportGrid: () => CellGrid;
  /** Read xterm.js's full grid including scrollback (from row 0) */
  readFullGrid: () => CellGrid;
  /** Number of rows scrolled into scrollback in xterm.js */
  xtermBaseY: () => number;
  /** Handle resize: update stdout dimensions, recreate VirtualScreen */
  resize: (cols: number, rows: number) => void;
  /** Clean up resources */
  dispose: () => void;
}

/**
 * Create a verified frame loop that pipes output to both a capture buffer
 * and a VirtualScreen (xterm.js) for visual correctness verification.
 */
export function createVerifiedFrameLoop(
  cols: number = 40,
  rows: number = 10,
): VerifiedFrameLoopInstance {
  let screen = new VirtualScreen(cols, rows);
  // Buffer of writes that haven't been flushed to xterm yet
  let pendingWrites: string[] = [];

  const stdout = createVerifiedStdout(cols, rows, (chunk: string) => {
    pendingWrites.push(chunk);
  });

  const loop = createFrameLoop(stdout as any);

  async function flushToXterm(): Promise<void> {
    // Drain all pending writes into xterm.js
    while (pendingWrites.length > 0) {
      const writes = pendingWrites;
      pendingWrites = [];
      for (const chunk of writes) {
        await screen.write(chunk);
      }
    }
  }

  async function flush(): Promise<void> {
    // Wait for React concurrent mode + frame loop timers to settle
    for (let i = 0; i < 8; i++) {
      await new Promise<void>((r) => setTimeout(r, 10));
    }
    // Now drain any writes that accumulated to xterm.js
    await flushToXterm();
  }

  function assertFrameCorrect(label: string = 'frame'): void {
    const cellstateGrid = loop.getGrid();
    if (!cellstateGrid) {
      throw new Error(`${label}: CellState grid is null (no frame rendered)`);
    }
    const xtermGrid = screen.readViewportGrid();
    assertGridsMatch(
      xtermGrid,
      cellstateGrid,
      label,
      `scrollback: cellstate=${loop.getScrollbackLines()} xterm=${screen.baseY}`,
    );
  }

  function resize(newCols: number, newRows: number): void {
    stdout.columns = newCols;
    stdout.rows = newRows;
    screen.resize(newCols, newRows);
    pendingWrites = [];
    stdout.emit('resize');
  }

  return {
    loop,
    stdout,
    flush,
    assertFrameCorrect,
    readViewportGrid: () => screen.readViewportGrid(),
    readFullGrid: () => screen.readGrid(),
    xtermBaseY: () => screen.baseY,
    resize,
    dispose: () => screen.dispose(),
  };
}
