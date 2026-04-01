/**
 * Frame loop: layout > rasterize > viewport extract > diff > ANSI output.
 * Handles three frame types: update (diff only), growth (scrollback push +
 * redraw), and full redraw (resize or content shrink).
 */
import type { TNode } from './nodes.js';
import type { CellGrid } from './cell.js';
import { layout, contentHeight } from './layout.js';
import { rasterize } from './rasterizer.js';
import { diff, fullRedraw, lastContentRow, serializeRowRange, serializeRowsReflow, extractViewport } from './diff.js';
import { mountRoot } from './reconciler.js';
import { writeFileSync } from 'node:fs';
import { detectCapabilities, type TerminalCapabilities } from './capabilities.js';
import { createPerf, type Perf, type PerfSnapshot } from './perf.js';

export interface FrameLoopOptions {
  /** Override detected terminal capabilities. */
  capabilities?: Partial<TerminalCapabilities>;
  /** Enable in-memory performance instrumentation (default: false). */
  perf?: boolean;
}

export interface FrameLoop {
  start: (element: React.ReactElement) => void;
  stop: () => void;
  update: (element: React.ReactElement) => void;
  getGrid: () => CellGrid | null;
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
const CLEAR_SCREEN_SCROLLBACK_HOME = '\x1b[2J\x1b[3J\x1b[H'; // Clear viewport + scrollback + home


export function createFrameLoop(
  stdout: NodeJS.WriteStream,
  options?: FrameLoopOptions | Partial<TerminalCapabilities>,
): FrameLoop {
  // Accept either the new FrameLoopOptions bag or the legacy capabilities
  // object for backward compatibility.
  const isOptsObject = (o: unknown): o is FrameLoopOptions =>
    typeof o === 'object' && o !== null && ('capabilities' in o || 'perf' in o);
  const opts: FrameLoopOptions =
    isOptsObject(options) ? options : { capabilities: options };

  // Merge caller-provided overrides with detected capabilities.
  const caps = { ...detectCapabilities(), ...opts.capabilities };

  const perfEnabled = opts.perf ?? (process.env.CELLSTATE_PERF === '1');
  const perf: Perf = createPerf(perfEnabled);
  // When disabled, pass undefined so diff/extractViewport/createGrid skip
  // all `if (perf)` guards without even a no-op function call.
  const perfOrUndef = perf.enabled ? perf : undefined;

  // DEC 2026 wraps frame output so supporting terminals paint atomically.
  // Terminals that don't recognize mode 2026 silently ignore the sequences,
  // but multiplexers (tmux, screen) and Mosh can't pass them through.
  const DEC_2026_ON = caps.synchronizedOutput ? '\x1b[?2026h' : '';
  const DEC_2026_OFF = caps.synchronizedOutput ? '\x1b[?2026l' : '';
  let prevGrid: CellGrid | null = null;
  let lastGrid: CellGrid | null = null;
  let updateHandle: ((el: React.ReactElement) => void) | null = null;
  let lastRoot: TNode | null = null;
  let isFlushing = false;
  let pendingRoot: TNode | null = null;
  let resizeListener: (() => void) | null = null;
  let drainListener: (() => void) | null = null;
  let isFirstFrame = true;
  let scrollbackRows = 0;

  function processFrame(root: TNode): void {
    perf.count('frames');
    const cols = stdout.columns ?? 80;
    const rows = stdout.rows ?? 24;

    perf.timeStart('layout');
    layout(root, cols, rows, perfOrUndef);
    perf.timeEnd('layout');

    if (isFirstFrame) {
      isFirstFrame = false;
      perf.count('framesFullRedraw');
      doFullRedraw(root, cols, rows);
      return;
    }

    // Rasterize full content into back buffer once.
    // actualHeight from the rasterized grid is the source of truth.
    const ch = contentHeight(root);
    perf.timeStart('rasterize');
    const fullGrid = rasterize(root, cols, Math.max(ch + 10, rows), 0, perfOrUndef);
    perf.timeEnd('rasterize');
    const actualHeight = lastContentRow(fullGrid) + 1;
    const desiredScrollback = Math.max(0, actualHeight - rows);

    if (desiredScrollback < scrollbackRows) {
      // Scrollback contains rows that no longer exist; must clear and rebuild
      perf.count('framesFullRedraw');
      doFullRedraw(root, cols, rows);
      return;
    }

    if (desiredScrollback > scrollbackRows) {
      // Content grew past viewport, growth frame
      perf.count('framesGrowth');
      doGrowthFrame(cols, rows, fullGrid, actualHeight, desiredScrollback);
      return;
    }

    // No scrollback change, update frame
    perf.count('framesUpdate');
    doUpdateFrame(cols, rows, fullGrid, actualHeight, desiredScrollback);
  }

  function doFullRedraw(
    root: TNode,
    cols: number,
    rows: number,
  ): void {
    // Reset stale state. growthInner sets the real scrollbackRows value below.
    scrollbackRows = 0;
    prevGrid = null;

    const ch = contentHeight(root);

    if (ch <= 0) {
      // Nothing to draw, just clear
      const output = DEC_2026_ON + CLEAR_SCREEN_SCROLLBACK_HOME + CURSOR_HIDE + DEC_2026_OFF;
      perf.timeStart('write');
      const ok = stdout.write(output);
      perf.timeEnd('write');
      perf.count('bytesWritten', output.length);
      perf.count('bytesFullRedraw', output.length);
      if (!ok) { isFlushing = true; perf.count('drainWaits'); }
      return;
    }

    // Rasterize full content; derive actual height from rasterized grid
    perf.timeStart('rasterize');
    const fullGrid = rasterize(root, cols, Math.max(ch + 10, rows), 0, perfOrUndef);
    perf.timeEnd('rasterize');
    const actualHeight = lastContentRow(fullGrid) + 1;
    const desiredScrollback = Math.max(0, actualHeight - rows);

    const { scrollSeq, redrawSeq } = growthInner(fullGrid, actualHeight, desiredScrollback, cols, rows);

    // Two separate DEC 2026 blocks: the terminal needs to finish processing
    // scroll state changes (clear, pre-paint, push rows into scrollback) before
    // the viewport redraw begins. Batching them risks the viewport redraw
    // landing at the wrong scroll offset on terminals that flush scroll state
    // lazily within a synchronized block.
    const block1 = DEC_2026_ON + CLEAR_SCREEN_SCROLLBACK_HOME + CURSOR_HIDE + scrollSeq + DEC_2026_OFF;
    const block2 = DEC_2026_ON + redrawSeq + DEC_2026_OFF;
    const totalBytes = block1.length + block2.length;
    perf.count('bytesWritten', totalBytes);
    perf.count('bytesFullRedraw', totalBytes);
    perf.timeStart('write');
    const ok1 = stdout.write(block1);
    if (!ok1) { isFlushing = true; perf.count('drainWaits'); }
    const ok2 = stdout.write(block2);
    perf.timeEnd('write');
    if (!ok2) { isFlushing = true; perf.count('drainWaits'); }
  }

  function doGrowthFrame(
    cols: number,
    rows: number,
    fullGrid: CellGrid,
    actualHeight: number,
    desiredScrollback: number,
  ): void {
    const { scrollSeq, redrawSeq } = growthInner(fullGrid, actualHeight, desiredScrollback, cols, rows);

    const output = DEC_2026_ON + scrollSeq + redrawSeq + DEC_2026_OFF;
    perf.count('bytesWritten', output.length);
    perf.count('bytesGrowth', output.length);
    perf.timeStart('write');
    const ok = stdout.write(output);
    perf.timeEnd('write');
    if (!ok) { isFlushing = true; perf.count('drainWaits'); }
  }

  interface GrowthResult {
    /**
     * Pre-paint + scroll sequence. When scrollNeeded > 0: serializeRowRange at
     * current scrollOffset so rows about to enter scrollback carry new content,
     * then \n × batch to push them there. Empty when no scrolling needed.
     */
    scrollSeq: string;
    /** Viewport redraw: \x1b[H + fullRedraw at final scrollOffset. */
    redrawSeq: string;
  }

  /**
   * Core growth sequence using the pre-rasterized fullGrid as source of truth.
   * serializeRowRange reads directly from fullGrid for pre-paint, eliminating
   * the need to rasterize multiple times at different scroll offsets.
   */
  function growthInner(
    fullGrid: CellGrid,
    _actualHeight: number,
    desiredScrollback: number,
    cols: number,
    rows: number,
  ): GrowthResult {
    const scrollNeeded = desiredScrollback - scrollbackRows;
    let scrollSeq = '';

    if (scrollNeeded > 0) {
      let offset = scrollbackRows;
      let remaining = scrollNeeded;

      perf.timeStart('serialize');
      while (remaining > 0) {
        const batch = Math.min(remaining, rows);

        // Pre-paint rows about to enter scrollback with new content from fullGrid
        scrollSeq += '\x1b[H';
        scrollSeq += serializeRowRange(fullGrid, offset, offset + batch).output;

        // Push pre-painted rows into scrollback
        scrollSeq += `\x1b[${rows};1H`;
        scrollSeq += '\n'.repeat(batch);

        offset += batch;
        remaining -= batch;
      }
      perf.timeEnd('serialize');
    }

    scrollbackRows = desiredScrollback;

    const viewportGrid = extractViewport(fullGrid, desiredScrollback, rows, perfOrUndef);
    perf.timeStart('serialize');
    const redraw = fullRedraw(viewportGrid, 0);
    perf.timeEnd('serialize');
    const redrawSeq = '\x1b[H' + redraw.output;
    prevGrid = viewportGrid;
    lastGrid = viewportGrid;

    // cols unused here but kept in signature for symmetry with callers
    void cols;

    return { scrollSeq, redrawSeq };
  }

  function doUpdateFrame(
    _cols: number,
    rows: number,
    fullGrid: CellGrid,
    actualHeight: number,
    desiredScrollback: number,
  ): void {
    scrollbackRows = desiredScrollback;

    const viewportGrid = extractViewport(fullGrid, scrollbackRows, rows, perfOrUndef);

    let result: { output: string; endRow: number; endCol: number };
    if (prevGrid === null) {
      // prevGrid is null after resize, fall back to full viewport redraw
      perf.count('diffFullRedrawFallbacks');
      perf.timeStart('serialize');
      result = fullRedraw(viewportGrid, 0);
      perf.timeEnd('serialize');
    } else {
      // diff() self-times and self-counts when perfOrUndef is provided
      result = diff(prevGrid, viewportGrid, 0, 0, perfOrUndef);
    }

    prevGrid = viewportGrid;
    lastGrid = viewportGrid;

    if (result.output.length === 0) {
      perf.count('framesSkipped');
      return;
    }

    const output = DEC_2026_ON + '\x1b[H' + result.output + DEC_2026_OFF;
    perf.count('bytesWritten', output.length);
    perf.count('bytesUpdate', output.length);

    perf.timeStart('write');
    const ok = stdout.write(output);
    perf.timeEnd('write');
    if (!ok) { isFlushing = true; perf.count('drainWaits'); }
  }

  let frameTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Flush the latest pending root through the render pipeline.
   * After each write, schedules another flush after a gap so
   * the terminal has time to process the ANSI output.
   */
  function flushFrame(): void {
    frameTimer = null;
    if (pendingRoot !== null && !isFlushing) {
      const root = pendingRoot;
      pendingRoot = null;
      processFrame(root);
      frameTimer = setTimeout(flushFrame, 4);
    }
  }

  function onFrame(root: TNode): void {
    lastRoot = root;
    pendingRoot = root;

    if (isFlushing) return;

    // If no timer running, start one. The short delay batches rapid
    // React commits (from SSE events arriving in separate read() calls)
    // into a single rendered frame showing the final state.
    // The timer is NEVER reset. New commits just update pendingRoot.
    if (frameTimer === null) {
      frameTimer = setTimeout(flushFrame, 8);
    }
  }

  function onDrain(): void {
    isFlushing = false;
    // drainWaits is counted when backpressure is detected (isFlushing set);
    // this handler fires when the drain completes.
    if (pendingRoot !== null && frameTimer === null) {
      frameTimer = setTimeout(flushFrame, 4);
    }
  }

  function onResize(): void {
    const oldScrollback = scrollbackRows;

    // Cancel any pending frame; resize does its own full redraw
    if (frameTimer !== null) {
      clearTimeout(frameTimer);
      frameTimer = null;
    }
    pendingRoot = null;

    prevGrid = null;
    scrollbackRows = 0;
    isFirstFrame = false; // Not first frame, but we'll do a full redraw

    if (lastRoot !== null) {
      const cols = stdout.columns ?? 80;
      const rows = stdout.rows ?? 24;

      layout(lastRoot, cols, rows, perfOrUndef);

      if (process.env.DEBUG) {
        process.stderr.write(
          `[RESIZE] cols=${cols} rows=${rows} ` +
          `oldScrollback=${oldScrollback}\n`
        );
      }

      doFullRedraw(lastRoot, cols, rows);
    }
  }

  return {
    start(element: React.ReactElement): void {
      stdout.write(CURSOR_HIDE);

      const handle = mountRoot(element, onFrame);
      updateHandle = handle.update;

      drainListener = onDrain;
      stdout.on('drain', drainListener);

      resizeListener = onResize;
      stdout.on('resize', resizeListener);
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
      // Kill flush guard state. Teardown is unconditional, not a frame.
      if (frameTimer !== null) {
        clearTimeout(frameTimer);
        frameTimer = null;
      }
      isFlushing = false;
      pendingRoot = null;

      const cols = stdout.columns ?? 80;
      const rows = stdout.rows ?? 24;

      if (lastRoot !== null) {
        try {
          layout(lastRoot, cols, rows, perfOrUndef);
          const ch = contentHeight(lastRoot);
          const grid = rasterize(lastRoot, cols, ch, 0, perfOrUndef);
          const result = serializeRowsReflow(grid);
          writeFileSync(
            1,
            CLEAR_SCREEN_SCROLLBACK_HOME +
              result.output +
              '\n' +
              CURSOR_SHOW,
          );
        } catch {
          // Repaint failed, fall back to safe exit
          writeFileSync(1, `\x1b[${rows};1H\n` + CURSOR_SHOW);
        }
      } else {
        writeFileSync(1, `\x1b[${rows};1H\n` + CURSOR_SHOW);
      }
    },

    update(element: React.ReactElement): void {
      if (updateHandle) {
        updateHandle(element);
      }
    },

    getGrid(): CellGrid | null {
      return lastGrid;
    },

    getScrollbackLines(): number {
      return scrollbackRows;
    },

    dumpFrameLog(path: string): void {
      const snapshot = {
        ts: Date.now(),
        cols: stdout.columns ?? 80,
        rows: stdout.rows ?? 24,
        scrollbackRows,
        isFlushing,
        hasPendingRoot: pendingRoot !== null,
        hasLastRoot: lastRoot !== null,
        isFirstFrame,
        prevGridSize: prevGrid ? { width: prevGrid.width, height: prevGrid.height } : null,
        lastGridSize: lastGrid ? { width: lastGrid.width, height: lastGrid.height } : null,
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
