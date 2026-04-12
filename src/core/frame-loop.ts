/**
 * Frame loop: layout > paint (packed buffer) > damage-scoped diff > ANSI output.
 *
 * Uses full-content front/back CellBuffers with damage rectangles to scope
 * the diff iteration region. Growth frames use a unified path: detect growth,
 * pre-paint unreachable rows, push, then damage-scoped diff.
 */
import type { TNode } from './nodes.js';
import { ColorMode, type CellGrid, type Cell } from './cell.js';
// populateLayoutResults is now merged into paintTree — Yoga values are read
// inline during the paint walk, so blitted subtrees skip layout extraction.
import { createFlexNodeFactory } from '../layout/yoga-flex.js';
import { setFlexNodeFactory } from './reconciler.js';
import { paintTree } from './paint.js';
import {
  type CellBuffer,
  createCellBuffer,
  resizeBuffer,
  lastNonBlankRow,
  viewportSlice,
} from './cell-buffer.js';
import { CharTable } from './char-table.js';
import { StyleTable } from './style-table.js';
import { LinkTable } from './link-table.js';
import {
  diffBuffers,
  serializeAll,
  serializeNewRows,
  serializeRowsForExit,
  InlineCursor,
} from './emit.js';
import { readCell, WIDE_WIDTH, CONTINUATION_WIDTH } from './cell-buffer.js';
import { mountRoot } from './reconciler.js';
import { writeFileSync } from 'node:fs';
import { detectCapabilities, type TerminalCapabilities } from './capabilities.js';
import { createPerf, type Perf, type PerfSnapshot } from './perf.js';
import chalk from 'chalk';

export interface FrameLoopOptions {
  /** Override detected terminal capabilities. */
  capabilities?: Partial<TerminalCapabilities>;
  /** Enable in-memory performance instrumentation (default: false). */
  perf?: boolean;
  /**
   * When true, every React commit renders a frame synchronously (no
   * throttling).  Useful for tests that check grid state immediately
   * after a React update.  Default: false.
   */
  immediateMode?: boolean;
}

export interface FrameLoop {
  start: (element: React.ReactElement) => void;
  stop: () => void;
  update: (element: React.ReactElement) => void;
  /** @deprecated Use getBuffer() + getCharTable()/getStyleTable() instead. */
  getGrid: () => CellGrid | null;
  getBuffer: () => CellBuffer | null;
  getCharTable: () => CharTable;
  getStyleTable: () => StyleTable;
  getLinkTable: () => LinkTable;
  getScrollbackLines: () => number;
  dumpFrameLog: (path: string) => void;
  /** Return a perf snapshot, or null when instrumentation is disabled. */
  perfSnapshot: () => PerfSnapshot | null;
  /** Reset perf counters/timings. No-op when disabled. */
  perfReset: () => void;
}

// Terminal control sequences (non-capability-dependent).
const CURSOR_HIDE = '\x1b[?25l';     // DECTCEM: hide cursor
const CURSOR_SHOW = '\x1b[?25h';     // DECTCEM: restore cursor visibility

/** Detect whether win32 is running under a modern terminal that supports
 *  full VT sequences (Windows Terminal, VS Code ConPTY, mintty/MSYS2). */
function isModernWindowsTerminal(): boolean {
  if (process.env.WT_SESSION) return true;                          // Windows Terminal
  if (process.env.TERM_PROGRAM === 'vscode') return true;           // VS Code integrated terminal
  if (process.env.TERM_PROGRAM === 'mintty') return true;           // mintty native
  if (process.env.MSYSTEM) return true;                             // GitBash / MSYS2 / MINGW
  return false;
}

function detectClearSequence(): string {
  if (process.platform !== 'win32' || isModernWindowsTerminal()) {
    return '\x1b[2J\x1b[3J\x1b[H';  // Clear viewport + scrollback + CUP home
  }
  // Legacy Windows console: no scrollback erase, HVP instead of CUP
  return '\x1b[2J\x1b[0f';
}

const CLEAR_SCREEN_SCROLLBACK_HOME = detectClearSequence();


export function createFrameLoop(
  stdout: NodeJS.WriteStream,
  options?: FrameLoopOptions | Partial<TerminalCapabilities>,
): FrameLoop {
  const isOptsObject = (o: unknown): o is FrameLoopOptions =>
    typeof o === 'object' && o !== null && ('capabilities' in o || 'perf' in o || 'immediateMode' in o);
  const opts: FrameLoopOptions =
    isOptsObject(options) ? options : { capabilities: options };

  const isTTY = stdout.isTTY ?? false;
  const caps = { ...detectCapabilities(), ...opts.capabilities };

  const perfEnabled = opts.perf ?? (process.env.CELLSTATE_PERF === '1');
  const perf: Perf = createPerf(perfEnabled);
  const perfOrUndef = perf.enabled ? perf : undefined;

  const DEC_2026_ON = caps.synchronizedOutput ? '\x1b[?2026h' : '';
  const DEC_2026_OFF = caps.synchronizedOutput ? '\x1b[?2026l' : '';
  const hyperlinksEnabled = caps.hyperlinks ?? false;

  // --- Color level detection ---
  // Derive from chalk.level for real TTYs. Boost to match detected caps
  // since chalk can't probe a mock/non-standard stream.
  let colorLevel = chalk.level;
  if (caps.truecolor && colorLevel < 3) colorLevel = 3;
  else if (!isTTY) colorLevel = 3; // piped output: preserve full color
  // Apply tmux clamping: tmux often doesn't pass through truecolor
  if (caps.multiplexer === 'tmux' && colorLevel > 2) {
    colorLevel = 2;
  }
  // Apply VS Code boost: xterm.js supports truecolor but doesn't always advertise
  if (caps.terminalName?.includes('vscode') && colorLevel === 2) {
    colorLevel = 3;
  }

  // --- Interning tables (session lifetime) ---
  const charTable = new CharTable();
  const styleTable = new StyleTable(colorLevel);
  const linkTable = new LinkTable();

  // --- Frame state ---
  /** Full-content buffer from the previous frame. null until first frame. */
  let frontRef: CellBuffer | null = null;
  /** Spare buffer slot for double-buffering reuse. */
  let spareRef: CellBuffer | null = null;
  let updateHandle: ((el: React.ReactElement) => void) | null = null;
  let lastRoot: TNode | null = null;
  let isFlushing = false;
  let pendingRoot: TNode | null = null;
  let resizeListener: (() => void) | null = null;
  let drainListener: (() => void) | null = null;
  let sigcontListener: (() => void) | null = null;
  let isFirstFrame = true;
  let contaminated = false;
  /** Viewport rows from the most recent processFrame, for getGrid(). */
  let lastViewportRows = 0;

  /** Cursor position at end of previous frame, relative to content origin.
   *  null before first frame.
   *  INVARIANT: nothing writes to stdout between frames. patchConsole
   *  redirects console.* to stderr. If any stdout write occurs between
   *  frames, cursorPark will be stale and output will be misaligned.
   *  The only recovery is setting contaminated = true. */
  let cursorPark: { col: number; row: number } | null = null;

  /** Content height (in rows) from the most recent frame. */
  let lastFrameHeight = 0;

  // --- Buffer management ---

  /** Get a cleared back buffer of the right size, reusing spareRef when possible. */
  function prepareBackBuffer(cols: number, height: number): CellBuffer {
    let buf: CellBuffer;
    if (spareRef) {
      buf = resizeBuffer(spareRef, cols, height);
      spareRef = null;
    } else {
      buf = createCellBuffer(cols, height);
    }
    // resizeBuffer and createCellBuffer both return cleared buffers
    return buf;
  }

  const ESC = '\x1b[';

  /**
   * Emit the full content of backBuffer using serializeAll, park the cursor,
   * and update frame state. Used by FIRST FRAME and CONTAMINATED paths.
   * When erase is true, prepends the clear-screen sequence.
   */
  function emitFullContent(
    backBuffer: CellBuffer,
    contentHeight: number,
    viewportRows: number,
    erase: boolean,
  ): void {
    const cursor = new InlineCursor(0, 0, backBuffer.width);

    perf.timeStart('serialize');
    serializeAll(backBuffer, styleTable, charTable, linkTable, hyperlinksEnabled, cursor);
    perf.timeEnd('serialize');

    // Park through the cursor
    cursor.moveTo(0, contentHeight - 1);
    if (contentHeight < viewportRows) cursor.newline();
    cursorPark = { col: cursor.col, row: cursor.row };

    let output = DEC_2026_ON;
    if (erase) output += CLEAR_SCREEN_SCROLLBACK_HOME;
    output += CURSOR_HIDE;
    output += cursor.output;
    output += DEC_2026_OFF;

    perf.count('bytesWritten', output.length);
    perf.count('bytesFullRedraw', output.length);
    perf.timeStart('write');
    const ok = stdout.write(output);
    perf.timeEnd('write');
    if (!ok) { isFlushing = true; perf.count('drainWaits'); }

    lastFrameHeight = contentHeight;
    spareRef = frontRef;
    frontRef = backBuffer;
  }

  /**
   * Compute how many top rows are unreachable (in terminal scrollback).
   * If content filled or exceeded the viewport last frame AND the cursor
   * was parked past the viewport bottom, the park \r\n scrolled 1 extra
   * row into scrollback.
   */
  function computeUnreachableRows(viewportRows: number): number {
    if (!cursorPark) return 0;
    const contentScrollback = Math.max(0, lastFrameHeight - viewportRows);
    const parkScreenRow = cursorPark.row - contentScrollback;
    const parkingScrollOffset = parkScreenRow >= viewportRows ? 1 : 0;
    return contentScrollback + parkingScrollOffset;
  }

  // --- Non-TTY frame processing (piped output) ---

  function processPipedFrame(root: TNode): void {
    perf.count('frames');
    const cols = stdout.columns ?? 80;

    perf.timeStart('layout');
    root.flexNode!.setWidth(cols);
    root.flexNode!.calculateLayout(cols);
    perf.timeEnd('layout');

    const ch = root.flexNode!.getComputedHeight();
    if (ch <= 0) return;

    const bufHeight = Math.max(ch, 1);
    perf.timeStart('rasterize');
    const buf = prepareBackBuffer(cols, bufHeight);
    paintTree(root, buf, null, charTable, styleTable, linkTable, 0, perfOrUndef);
    perf.timeEnd('rasterize');

    perf.timeStart('serialize');
    const result = serializeRowsForExit(buf, styleTable, charTable, linkTable, false);
    perf.timeEnd('serialize');

    const output = result.output + '\n';
    perf.count('bytesWritten', output.length);
    perf.timeStart('write');
    const ok = stdout.write(output);
    perf.timeEnd('write');
    if (!ok) { isFlushing = true; perf.count('drainWaits'); }

    // Return buf to spare pool — no front/back tracking needed
    spareRef = buf;
  }

  // --- Main frame processing ---

  function processFrame(root: TNode): void {
    if (!isTTY) { processPipedFrame(root); return; }

    perf.count('frames');
    const cols = stdout.columns ?? 80;
    const viewportRows = stdout.rows ?? 24;
    lastViewportRows = viewportRows;

    perf.timeStart('layout');
    root.flexNode!.setWidth(cols);
    root.flexNode!.calculateLayout(cols);
    perf.timeEnd('layout');

    const ch = root.flexNode!.getComputedHeight();
    const cw = root.flexNode!.getComputedWidth();

    // --- Degenerate: bad yoga dimensions ---
    if (!Number.isFinite(ch) || ch < 0 || !Number.isFinite(cw) || cw < 0) {
      if (process.env.DEBUG) {
        process.stderr.write(
          `[FRAME] bad yoga dimensions: width=${cw} height=${ch}\n`,
        );
      }
      contaminated = true;
      cursorPark = null;
      lastFrameHeight = 0;
      frontRef = null;
      isFirstFrame = false;
      const output = DEC_2026_ON + CURSOR_HIDE + DEC_2026_OFF;
      perf.timeStart('write');
      const ok = stdout.write(output);
      perf.timeEnd('write');
      perf.count('bytesWritten', output.length);
      if (!ok) { isFlushing = true; perf.count('drainWaits'); }
      return;
    }

    // --- Degenerate: zero content ---
    if (ch <= 0) {
      if (isFirstFrame || contaminated || frontRef === null || cursorPark === null) {
        // Nothing to show — clear screen and reset
        contaminated = false;
        isFirstFrame = false;
        cursorPark = null;
        lastFrameHeight = 0;
        frontRef = null;
        const output = DEC_2026_ON + CLEAR_SCREEN_SCROLLBACK_HOME + CURSOR_HIDE + DEC_2026_OFF;
        perf.timeStart('write');
        const ok = stdout.write(output);
        perf.timeEnd('write');
        perf.count('bytesWritten', output.length);
        perf.count('bytesFullRedraw', output.length);
        if (!ok) { isFlushing = true; perf.count('drainWaits'); }
      }
      return;
    }

    // --- CONTAMINATED (SIGCONT/resize) — check BEFORE first frame ---
    if (contaminated) {
      contaminated = false;
      perf.count('framesFullRedraw');

      const bufHeight = Math.max(ch, 1);
      perf.timeStart('rasterize');
      const backBuffer = prepareBackBuffer(cols, bufHeight);
      paintTree(root, backBuffer, null, charTable, styleTable, linkTable, 0, perfOrUndef);
      perf.timeEnd('rasterize');
      const contentHeight = lastNonBlankRow(backBuffer) + 1;

      emitFullContent(backBuffer, contentHeight, viewportRows, true);
      isFirstFrame = false;
      return;
    }

    // --- FIRST FRAME ---
    if (isFirstFrame || frontRef === null || cursorPark === null) {
      isFirstFrame = false;
      perf.count('framesFullRedraw');

      const bufHeight = Math.max(ch, 1);
      perf.timeStart('rasterize');
      const backBuffer = prepareBackBuffer(cols, bufHeight);
      paintTree(root, backBuffer, null, charTable, styleTable, linkTable, 0, perfOrUndef);
      perf.timeEnd('rasterize');
      const contentHeight = lastNonBlankRow(backBuffer) + 1;

      emitFullContent(backBuffer, contentHeight, viewportRows, false);
      return;
    }

    // --- Paint into back buffer ---
    const bufHeight = Math.max(ch, 1);
    perf.timeStart('rasterize');
    const backBuffer = prepareBackBuffer(cols, bufHeight);
    paintTree(root, backBuffer, frontRef, charTable, styleTable, linkTable, 0, perfOrUndef);
    perf.timeEnd('rasterize');
    const contentHeight = lastNonBlankRow(backBuffer) + 1;

    // --- Log damage dimensions ---
    if (process.env.DEBUG && backBuffer.damageBox) {
      const d = backBuffer.damageBox;
      const w = d.maxCol - d.minCol + 1;
      const h = d.maxRow - d.minRow + 1;
      process.stderr.write(`[FRAME] damage=${w}x${h}+${d.minCol}+${d.minRow}\n`);
    } else if (process.env.DEBUG) {
      process.stderr.write('[FRAME] damage=none\n');
    }

    // --- Compute unreachable rows ---
    const unreachableRows = computeUnreachableRows(viewportRows);

    // --- Track damage perf counters ---
    if (perfOrUndef && backBuffer.damageBox) {
      const d = backBuffer.damageBox;
      const damageCells = (d.maxRow - d.minRow + 1) * (d.maxCol - d.minCol + 1);
      const viewportCells = viewportRows * cols;
      perfOrUndef.count('damageCells', damageCells);
      perfOrUndef.count('damageSkippedCells', Math.max(0, viewportCells - damageCells));
    }

    // --- Unreachable damage guard ---
    // If any unreachable rows exist (content in terminal scrollback), check
    // whether the current frame would need to touch them. If so, fall back
    // to CONTAMINATED path (full reset).
    if (unreachableRows > 0) {
      // For shrink: cursor positioning math for orphan erase assumes no
      // scrollback. Any shrink with scrollback needs a full reset.
      const shrinkNeedsReset = contentHeight < lastFrameHeight;

      // For update/growth: walk the unreachable rows cell-by-cell and only
      // force a reset if front and back actually differ there. Damage bounds
      // would over-trigger this — blitted regions always expand damage to
      // catch terminal desync, but their cells are identical to the front
      // and so don't require a reset. Compare BigInt64 packed cells
      // directly via cellBulk for a fast, allocation-free scan.
      const front = frontRef!;
      const compareRows = Math.min(unreachableRows, front.height, backBuffer.height);
      const compareWidth = Math.min(front.width, backBuffer.width);
      let damageNeedsReset = false;
      for (let r = 0; r < compareRows && !damageNeedsReset; r++) {
        const fBase = r * front.width;
        const bBase = r * backBuffer.width;
        for (let c = 0; c < compareWidth; c++) {
          if (front.cellBulk[fBase + c] !== backBuffer.cellBulk[bBase + c]) {
            damageNeedsReset = true;
            break;
          }
        }
      }
      // Width mismatch in the unreachable region also forces a reset.
      if (!damageNeedsReset && front.width !== backBuffer.width && compareRows > 0) {
        damageNeedsReset = true;
      }

      if (shrinkNeedsReset || damageNeedsReset) {
        if (process.env.DEBUG) {
          process.stderr.write(
            `[FRAME] full reset: unreachable rows=${unreachableRows}` +
            (shrinkNeedsReset ? ' (shrink)' : ' (unreachable cell diff)') + '\n',
          );
        }
        perf.count('framesFullRedraw');
        contaminated = true;
        processFrame(root);
        return;
      }
    }

    // --- Classify: UPDATE, GROWTH, or SHRINK ---

    if (contentHeight === lastFrameHeight) {
      // --- UPDATE (same height) ---
      perf.count('framesUpdate');

      // Diff only the reachable portion (rows visible on screen).
      // With scrollback, unreachable rows are in terminal scrollback and
      // can't be reached by relative cursor moves.
      const reachableStart = unreachableRows;
      const frontSlice = viewportSlice(frontRef!, reachableStart, contentHeight - reachableStart);
      const backSlice = viewportSlice(backBuffer, reachableStart, contentHeight - reachableStart);

      const cursor = new InlineCursor(cursorPark!.col, cursorPark!.row, cols);
      cursor.moveTo(0, 0); // preamble: move from park to content origin

      perf.timeStart('serialize');
      const preLen = cursor.output.length;
      diffBuffers(frontSlice, backSlice, styleTable, charTable, linkTable, hyperlinksEnabled, cursor, perfOrUndef);
      perf.timeEnd('serialize');

      spareRef = frontRef;
      frontRef = backBuffer;
      lastFrameHeight = contentHeight;

      if (cursor.output.length === preLen) {
        perf.count('framesSkipped');
        return;
      }

      // Park
      cursor.moveTo(0, contentHeight - 1);
      if (contentHeight < viewportRows) cursor.newline();
      cursorPark = { col: cursor.col, row: cursor.row };

      const frame = DEC_2026_ON + CURSOR_HIDE + cursor.output + DEC_2026_OFF;
      perf.count('bytesWritten', frame.length);
      perf.count('bytesUpdate', frame.length);
      perf.timeStart('write');
      const ok = stdout.write(frame);
      perf.timeEnd('write');
      if (!ok) { isFlushing = true; perf.count('drainWaits'); }
      return;
    }

    if (contentHeight > lastFrameHeight) {
      // --- GROWTH (taller) ---
      perf.count('framesGrowth');
      if (perfOrUndef) perfOrUndef.count('growthFrames');

      const cursor = new InlineCursor(cursorPark!.col, cursorPark!.row, cols);
      cursor.moveTo(0, 0); // preamble: move from park to content origin

      perf.timeStart('serialize');

      // Diff overlapping reachable rows only. With scrollback, unreachable
      // rows can't be reached by relative cursor moves.
      const reachableStart = unreachableRows;
      const overlapEnd = lastFrameHeight;
      const reachableOverlap = overlapEnd - reachableStart;
      const frontSlice = viewportSlice(frontRef!, reachableStart, reachableOverlap);
      const backSlice = viewportSlice(backBuffer, reachableStart, reachableOverlap);
      diffBuffers(frontSlice, backSlice, styleTable, charTable, linkTable, hyperlinksEnabled, cursor, perfOrUndef);

      // Move to last existing content row, then advance to new rows
      cursor.moveTo(0, lastFrameHeight - 1);
      cursor.newline();
      serializeNewRows(backBuffer, lastFrameHeight, contentHeight, styleTable, charTable, linkTable, hyperlinksEnabled, cursor, perfOrUndef);

      perf.timeEnd('serialize');

      // Park
      cursor.moveTo(0, contentHeight - 1);
      if (contentHeight < viewportRows) cursor.newline();
      cursorPark = { col: cursor.col, row: cursor.row };

      lastFrameHeight = contentHeight;
      spareRef = frontRef;
      frontRef = backBuffer;

      const frame = DEC_2026_ON + CURSOR_HIDE + cursor.output + DEC_2026_OFF;
      perf.count('bytesWritten', frame.length);
      perf.count('bytesGrowth', frame.length);
      perf.timeStart('write');
      const ok = stdout.write(frame);
      perf.timeEnd('write');
      if (!ok) { isFlushing = true; perf.count('drainWaits'); }
      return;
    }

    // --- SHRINK (shorter) ---
    perf.count('framesUpdate');

    const cursor = new InlineCursor(cursorPark!.col, cursorPark!.row, cols);
    cursor.moveTo(0, 0); // preamble: move from park to content origin

    perf.timeStart('serialize');

    // Diff overlapping rows (0..contentHeight-1) only
    const frontSlice = viewportSlice(frontRef!, 0, contentHeight);
    const backSlice = viewportSlice(backBuffer, 0, contentHeight);
    diffBuffers(frontSlice, backSlice, styleTable, charTable, linkTable, hyperlinksEnabled, cursor, perfOrUndef);

    // Erase orphan rows
    for (let r = contentHeight; r < lastFrameHeight; r++) {
      cursor.moveTo(0, r);
      cursor.writeRaw(`${ESC}2K`);
    }

    perf.timeEnd('serialize');

    // Park
    cursor.moveTo(0, contentHeight - 1);
    if (contentHeight < viewportRows) cursor.newline();
    cursorPark = { col: cursor.col, row: cursor.row };

    lastFrameHeight = contentHeight;
    spareRef = frontRef;
    frontRef = backBuffer;

    const frame = DEC_2026_ON + CURSOR_HIDE + cursor.output + DEC_2026_OFF;
    perf.count('bytesWritten', frame.length);
    perf.count('bytesUpdate', frame.length);
    perf.timeStart('write');
    const ok = stdout.write(frame);
    perf.timeEnd('write');
    if (!ok) { isFlushing = true; perf.count('drainWaits'); }
  }

  // --- Scheduling ---
  // React 19's ConcurrentRoot batches multiple setState calls within the
  // same task/microtask into a single commit.  However, during streaming
  // scenarios each network chunk arrives as a separate event (setTimeout /
  // IO callback), triggering a separate React commit.  Frame coalescing
  // ensures that only one rendered frame is produced per FRAME_INTERVAL
  // window, so rapid commits during fast streaming don't each trigger the
  // full layout → paint → diff → emit pipeline.

  const FRAME_INTERVAL = 16; // ms — minimum time between rendered frames
  const immediateMode = opts.immediateMode ?? false;

  let drainImmediate: ReturnType<typeof setImmediate> | null = null;
  let lastFrameTime = 0;
  let coalescedRoot: TNode | null = null;
  let frameTimer: ReturnType<typeof setTimeout> | null = null;

  function flushCoalesced(): void {
    frameTimer = null;
    if (coalescedRoot === null) return;
    if (isFlushing) {
      pendingRoot = coalescedRoot;
      coalescedRoot = null;
      return;
    }
    const root = coalescedRoot;
    coalescedRoot = null;
    lastFrameTime = performance.now();
    processFrame(root);
  }

  function flushFrame(): void {
    drainImmediate = null;
    if (coalescedRoot !== null && !isFlushing) {
      flushCoalesced();
    } else if (pendingRoot !== null && !isFlushing) {
      const root = pendingRoot;
      pendingRoot = null;
      processFrame(root);
    }
  }

  function onFrame(root: TNode): void {
    lastRoot = root;

    if (isFlushing) {
      pendingRoot = root;
      return;
    }

    if (immediateMode) {
      processFrame(root);
      return;
    }

    coalescedRoot = root;
    if (frameTimer !== null) return; // already scheduled, will pick up coalescedRoot

    const elapsed = performance.now() - lastFrameTime;
    if (elapsed >= FRAME_INTERVAL) {
      flushCoalesced();
    } else {
      frameTimer = setTimeout(flushCoalesced, FRAME_INTERVAL - elapsed);
    }
  }

  function onDrain(): void {
    isFlushing = false;
    if (coalescedRoot !== null && drainImmediate === null) {
      drainImmediate = setImmediate(flushFrame);
    } else if (pendingRoot !== null && drainImmediate === null) {
      drainImmediate = setImmediate(flushFrame);
    }
  }

  function onSigcont(): void {
    // Cancel any pending coalesced frame — SIGCONT supersedes it
    if (frameTimer !== null) {
      clearTimeout(frameTimer);
      frameTimer = null;
    }
    coalescedRoot = null;

    if (drainImmediate !== null) {
      clearImmediate(drainImmediate);
      drainImmediate = null;
    }
    pendingRoot = null;

    contaminated = true;
    cursorPark = null;
    lastFrameHeight = 0;

    // Terminal may restore cursor visibility on resume
    stdout.write(CURSOR_HIDE);

    if (lastRoot !== null) {
      processFrame(lastRoot);
      lastFrameTime = performance.now();
    }
  }

  function onResize(): void {
    // Cancel any pending coalesced frame — resize supersedes it
    if (frameTimer !== null) {
      clearTimeout(frameTimer);
      frameTimer = null;
    }
    coalescedRoot = null;

    if (drainImmediate !== null) {
      clearImmediate(drainImmediate);
      drainImmediate = null;
    }
    pendingRoot = null;

    // Save front for reuse as spare, then clear
    spareRef = frontRef;
    frontRef = null;
    cursorPark = null;
    lastFrameHeight = 0;
    contaminated = true; // Forces full-redraw on next processFrame
    isFirstFrame = false;

    if (lastRoot !== null) {
      if (process.env.DEBUG) {
        const cols = stdout.columns ?? 80;
        const rows = stdout.rows ?? 24;
        process.stderr.write(
          `[RESIZE] cols=${cols} rows=${rows}\n`
        );
      }

      // Process immediately — resize needs immediate synchronous rendering.
      processFrame(lastRoot);
      lastFrameTime = performance.now();
    }
  }

  return {
    start(element: React.ReactElement): void {
      setFlexNodeFactory(createFlexNodeFactory());
      const handle = mountRoot(element, onFrame);
      updateHandle = handle.update;

      drainListener = onDrain;
      stdout.on('drain', drainListener);

      if (isTTY) {
        stdout.write(CURSOR_HIDE);

        resizeListener = onResize;
        stdout.on('resize', resizeListener);

        if (process.platform !== 'win32') {
          sigcontListener = onSigcont;
          process.on('SIGCONT', sigcontListener);
        }
      }
    },

    stop(): void {
      if (resizeListener) {
        stdout.off('resize', resizeListener);
        resizeListener = null;
      }
      if (drainListener) {
        stdout.off('drain', drainListener);
        drainListener = null;
      }
      if (sigcontListener) {
        process.off('SIGCONT', sigcontListener);
        sigcontListener = null;
      }
      if (frameTimer !== null) {
        clearTimeout(frameTimer);
        frameTimer = null;
      }
      coalescedRoot = null;
      if (drainImmediate !== null) {
        clearImmediate(drainImmediate);
        drainImmediate = null;
      }
      isFlushing = false;
      pendingRoot = null;

      if (!isTTY) {
        // Piped output: emit final content without cursor/screen control
        if (lastRoot !== null) {
          try {
            const cols = stdout.columns ?? 80;
            lastRoot.flexNode!.setWidth(cols);
            lastRoot.flexNode!.calculateLayout(cols);
            const ch = lastRoot.flexNode!.getComputedHeight();
            const bufHeight = Math.max(ch, 1);
            const buf = createCellBuffer(cols, bufHeight);
            paintTree(lastRoot, buf, null, charTable, styleTable, linkTable, 0, perfOrUndef);
            const result = serializeRowsForExit(buf, styleTable, charTable, linkTable, false);
            writeFileSync(1, result.output + '\n');
          } catch {
            // nothing to write
          }
        }
        return;
      }

      const cols = stdout.columns ?? 80;

      if (lastRoot !== null) {
        try {
          lastRoot.flexNode!.setWidth(cols);
          lastRoot.flexNode!.calculateLayout(cols);
          const ch = lastRoot.flexNode!.getComputedHeight();
          const bufHeight = Math.max(ch, 1);
          const buf = createCellBuffer(cols, bufHeight);
          paintTree(lastRoot, buf, null, charTable, styleTable, linkTable, 0, perfOrUndef);
          const result = serializeRowsForExit(buf, styleTable, charTable, linkTable, hyperlinksEnabled);
          writeFileSync(
            1,
            CLEAR_SCREEN_SCROLLBACK_HOME +
              result.output +
              '\n' +
              CURSOR_SHOW,
          );
        } catch {
          writeFileSync(1, CLEAR_SCREEN_SCROLLBACK_HOME + CURSOR_SHOW);
        }
      } else {
        writeFileSync(1, CLEAR_SCREEN_SCROLLBACK_HOME + CURSOR_SHOW);
      }
    },

    update(element: React.ReactElement): void {
      if (updateHandle) {
        updateHandle(element);
      }
    },

    /** @deprecated Use getBuffer() with getCharTable()/getStyleTable() instead. */
    getGrid(): CellGrid | null {
      if (!frontRef) return null;
      const vp = lastViewportRows || frontRef.height;
      const scrollback = Math.max(0, lastFrameHeight - vp);
      const vpRows = Math.min(vp, frontRef.height - scrollback);
      const buf = viewportSlice(frontRef, scrollback, vpRows);
      const width = buf.width;
      // Inline CellBuffer → CellGrid conversion (was compat-bridge.ts)
      const cells: Cell[][] = [];
      for (let r = 0; r < buf.height; r++) {
        const row: Cell[] = [];
        for (let c = 0; c < width; c++) {
          const packed = readCell(buf, r, c)!;
          const ch = charTable.resolve(packed.charId);
          const style = styleTable.resolve(packed.styleId);
          let cellWidth: number;
          if (packed.width === WIDE_WIDTH) cellWidth = 2;
          else if (packed.width === CONTINUATION_WIDTH) cellWidth = 0;
          else cellWidth = 1;
          row.push({
            char: ch,
            width: cellWidth,
            fg: { mode: style.fgMode as ColorMode, value: style.fgValue },
            bg: { mode: style.bgMode as ColorMode, value: style.bgValue },
            attrs: style.attrs,
          });
        }
        cells.push(row);
      }
      // Pad to full viewport height with blank rows
      const blankCell: Cell = {
        char: ' ', width: 1,
        fg: { mode: ColorMode.Default, value: 0 },
        bg: { mode: ColorMode.Default, value: 0 },
        attrs: 0,
      };
      while (cells.length < vp) {
        const row: Cell[] = [];
        for (let c = 0; c < width; c++) row.push({ ...blankCell });
        cells.push(row);
      }
      return { cells, cursorRow: 0, cursorCol: 0, width, height: vp };
    },

    getBuffer(): CellBuffer | null {
      return frontRef;
    },

    getCharTable(): CharTable {
      return charTable;
    },

    getStyleTable(): StyleTable {
      return styleTable;
    },

    getLinkTable(): LinkTable {
      return linkTable;
    },

    /** @deprecated Derived from lastFrameHeight — scrollback is now tracked via cursorPark. */
    getScrollbackLines(): number {
      return Math.max(0, lastFrameHeight - lastViewportRows);
    },

    dumpFrameLog(path: string): void {
      const snapshot = {
        ts: Date.now(),
        cols: stdout.columns ?? 80,
        rows: stdout.rows ?? 24,
        cursorPark,
        lastFrameHeight,
        isFlushing,
        hasPendingRoot: pendingRoot !== null,
        hasLastRoot: lastRoot !== null,
        isFirstFrame,
        contaminated,
        frontBufferSize: frontRef ? { width: frontRef.width, height: frontRef.height } : null,
        tableSizes: {
          chars: charTable.size,
          styles: styleTable.size,
          links: linkTable.size,
        },
      };
      writeFileSync(path, JSON.stringify(snapshot, null, 2));
    },

    perfSnapshot() {
      return perf.snapshot();
    },

    perfReset() {
      perf.reset();
    },
  };
}
