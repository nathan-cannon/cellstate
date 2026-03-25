/**
 * Frame loop: layout > rasterize > viewport extract > diff > ANSI output.
 * Handles three frame types: update (diff only), growth (scrollback push +
 * redraw), and full redraw (resize or content shrink).
 */
import type { TNode } from './nodes.js';
import type { CellGrid } from '../cell.js';
import { layout, contentHeight } from './layout.js';
import { rasterize } from './rasterizer.js';
import { diff, fullRedraw, lastContentRow, serializeRowRange, serializeRowsReflow, extractViewport } from '../diff.js';
import { mountRoot } from './reconciler.js';
import { writeFileSync } from 'node:fs';

export interface FrameLoop {
  start: (element: React.ReactElement) => void;
  stop: () => void;
  update: (element: React.ReactElement) => void;
  getGrid: () => CellGrid | null;
  getScrollbackLines: () => number;
  dumpFrameLog: (path: string) => void;
}

// Terminal control sequences used throughout the frame loop.
// DEC 2026 wraps frame output so supporting terminals paint atomically.
const DEC_2026_ON = '\x1b[?2026h';   // Begin synchronized update
const DEC_2026_OFF = '\x1b[?2026l';  // End synchronized update, terminal flushes
const CURSOR_HIDE = '\x1b[?25l';     // DECTCEM: hide cursor
const CURSOR_SHOW = '\x1b[?25h';     // DECTCEM: restore cursor visibility
const CLEAR_SCREEN_SCROLLBACK_HOME = '\x1b[2J\x1b[3J\x1b[H'; // Clear viewport + scrollback + home


export function createFrameLoop(stdout: NodeJS.WriteStream): FrameLoop {
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
    const cols = stdout.columns ?? 80;
    const rows = stdout.rows ?? 24;

    layout(root, cols, rows);

    if (isFirstFrame) {
      isFirstFrame = false;
      doFullRedraw(root, cols, rows);
      return;
    }

    // Rasterize full content into back buffer once.
    // actualHeight from the rasterized grid is the source of truth.
    const ch = contentHeight(root);
    const fullGrid = rasterize(root, cols, Math.max(ch + 10, rows), 0);
    const actualHeight = lastContentRow(fullGrid) + 1;
    const desiredScrollback = Math.max(0, actualHeight - rows);

    if (desiredScrollback < scrollbackRows) {
      // Scrollback contains rows that no longer exist; must clear and rebuild
      doFullRedraw(root, cols, rows);
      return;
    }

    if (desiredScrollback > scrollbackRows) {
      // Content grew past viewport, growth frame
      doGrowthFrame(cols, rows, fullGrid, actualHeight, desiredScrollback);
      return;
    }

    // No scrollback change, update frame
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
      const ok = stdout.write(output);
      if (!ok) isFlushing = true;
      return;
    }

    // Rasterize full content; derive actual height from rasterized grid
    const fullGrid = rasterize(root, cols, Math.max(ch + 10, rows), 0);
    const actualHeight = lastContentRow(fullGrid) + 1;
    const desiredScrollback = Math.max(0, actualHeight - rows);

    const { scrollSeq, redrawSeq } = growthInner(fullGrid, actualHeight, desiredScrollback, cols, rows);

    if (process.env.DEBUG) {
      process.stderr.write(`[FULL] scroll=${scrollSeq.length} redraw=${redrawSeq.length} bytes (scrollback=${scrollbackRows}, contentHeight=${actualHeight}, viewport=${rows})\n`);
    }

    // Two separate DEC 2026 blocks: the terminal needs to finish processing
    // scroll state changes (clear, pre-paint, push rows into scrollback) before
    // the viewport redraw begins. Batching them risks the viewport redraw
    // landing at the wrong scroll offset on terminals that flush scroll state
    // lazily within a synchronized block.
    const ok1 = stdout.write(DEC_2026_ON + CLEAR_SCREEN_SCROLLBACK_HOME + CURSOR_HIDE + scrollSeq + DEC_2026_OFF);
    if (!ok1) isFlushing = true;
    const ok2 = stdout.write(DEC_2026_ON + redrawSeq + DEC_2026_OFF);
    if (!ok2) isFlushing = true;
  }

  function doGrowthFrame(
    cols: number,
    rows: number,
    fullGrid: CellGrid,
    actualHeight: number,
    desiredScrollback: number,
  ): void {
    const { scrollSeq, redrawSeq } = growthInner(fullGrid, actualHeight, desiredScrollback, cols, rows);

    if (process.env.DEBUG) {
      process.stderr.write(`[GROW] scroll=${scrollSeq.length} redraw=${redrawSeq.length} bytes (scrollback=${scrollbackRows}, contentHeight=${actualHeight}, viewport=${rows})\n`);
    }

    const output = DEC_2026_ON + scrollSeq + redrawSeq + DEC_2026_OFF;
    const ok = stdout.write(output);
    if (!ok) isFlushing = true;
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
    }

    scrollbackRows = desiredScrollback;

    const viewportGrid = extractViewport(fullGrid, desiredScrollback, rows);
    const redraw = fullRedraw(viewportGrid, 0);
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

    const viewportGrid = extractViewport(fullGrid, scrollbackRows, rows);

    let result: { output: string; endRow: number; endCol: number };
    if (prevGrid === null) {
      // prevGrid is null after resize, fall back to full viewport redraw
      result = fullRedraw(viewportGrid, 0);
    } else {
      result = diff(prevGrid, viewportGrid, 0, 0);
    }

    prevGrid = viewportGrid;
    lastGrid = viewportGrid;

    if (result.output.length === 0) return;

    const output = DEC_2026_ON + '\x1b[H' + result.output + DEC_2026_OFF;

    if (process.env.DEBUG) {
      process.stderr.write(`[DIFF] ${result.output.length} bytes (scrollback=${scrollbackRows}, contentHeight=${actualHeight}, viewport=${rows})\n`);
    }

    if (process.env.DEBUG) {
      const fs = require('fs');
      fs.appendFileSync('frame-debug.txt',
        `--- FRAME (DIFF) ---\n` +
        `contentHeight=${actualHeight} scrollbackRows=${scrollbackRows}\n` +
        `output bytes=${output.length}\n` +
        JSON.stringify(output) + '\n\n'
      );
    }

    const ok = stdout.write(output);
    if (!ok) isFlushing = true;
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

      layout(lastRoot, cols, rows);

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
          layout(lastRoot, cols, rows);
          const ch = contentHeight(lastRoot);
          const grid = rasterize(lastRoot, cols, ch, 0);
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
  };
}
