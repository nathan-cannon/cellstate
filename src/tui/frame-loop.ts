import type { TNode } from './nodes.js';
import type { CellGrid } from '../cell.js';
import { layout, contentHeight } from './layout.js';
import { rasterize } from './rasterizer.js';
import { diff, fullRedraw, lastContentRow, serializeRowRange, extractViewport } from '../diff.js';
import { mountRoot } from './reconciler.js';
import { writeFileSync } from 'node:fs';

export interface FrameLoop {
  start: (element: React.ReactElement) => void;
  stop: () => void;
  update: (element: React.ReactElement) => void;
  getGrid: () => CellGrid | null;
  /** Exposed for testing — how many rows have been pushed into terminal scrollback. */
  getScrollbackLines: () => number;
  /** Dump the last ~20 frame states to a file for debugging. */
  dumpFrameLog: (path: string) => void;
}

interface FrameLogEntry {
  ts: number;
  type: 'full' | 'growth' | 'update';
  contentHeight: number;
  previousContentHeight: number;
  scrollbackRows: number;
  effectiveViewport: number;
  cols: number;
  rows: number;
  /** Layout y of the last text node containing ❯ (the input prompt). -1 if not found. */
  inputNodeY: number;
  /** Height of the main content box (first non-fixed child of root). */
  mainBoxHeight: number;
  /** Number of children in the main content box. */
  mainBoxChildren: number;
  /** Trigger reason for full redraw. */
  fullRedrawReason?: string;
  /** Per-child details of the main content box. */
  mainBoxChildDetails?: {
    type: string;
    y: number;
    height: number;
    children: number;
    /** First text content or key prop for identification. */
    hint: string;
  }[];
  /** State of prevGrid at the START of this frame (before rasterize). */
  prevGridInfo?: {
    width: number;
    height: number;
    lastContentRow: number;
  } | null;
  /** Milliseconds since the previous frame. */
  msSincePrevFrame?: number;
  /** Type of the immediately preceding frame. */
  prevFrameType?: 'full' | 'growth' | 'update';
}

const DEC_2026_ON = '\x1b[?2026h';
const DEC_2026_OFF = '\x1b[?2026l';
const CURSOR_HIDE = '\x1b[?25l';
const CURSOR_SHOW = '\x1b[?25h';
const CLEAR_SCREEN_SCROLLBACK_HOME = '\x1b[2J\x1b[3J\x1b[H';


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

  // ── Frame diagnostic ring buffer ──
  const FRAME_LOG_SIZE = 20;
  const frameLog: FrameLogEntry[] = [];
  let lastFrameTs = 0;
  let lastFrameType: 'full' | 'growth' | 'update' | null = null;

  function findInputNodeY(root: TNode): number {
    // Walk tree depth-first looking for a text node whose segments start with ❯
    function walk(node: TNode): number {
      if (node.type === 'text' && node.props.segments) {
        const segs = node.props.segments as { text: string }[];
        if (segs.length > 0 && segs[0].text.startsWith('❯')) {
          return node.layout?.y ?? -1;
        }
      }
      for (const child of node.children) {
        const y = walk(child);
        if (y !== -1) return y;
      }
      return -1;
    }
    return walk(root);
  }

  function getMainBox(root: TNode): TNode | null {
    return root.children[0] ?? null;
  }

  function getChildHint(node: TNode): string {
    // For text nodes, return first ~40 chars of content
    if (node.type === 'text') {
      if (node.props.segments) {
        const segs = node.props.segments as { text: string }[];
        const txt = segs.map((s) => s.text).join('').slice(0, 40);
        return `text:${JSON.stringify(txt)}`;
      }
      return node.text ? `text:${JSON.stringify(node.text.slice(0, 40))}` : 'text:(empty)';
    }
    // For box nodes, peek at first text child or use props
    if (node.props.backgroundColor) return `box[bg=${node.props.backgroundColor}]`;
    // Peek at first descendant text for identification
    function firstText(n: TNode): string | null {
      if (n.type === 'text') {
        if (n.props.segments) {
          const segs = n.props.segments as { text: string }[];
          return segs.map((s) => s.text).join('').slice(0, 30);
        }
        return n.text?.slice(0, 30) ?? null;
      }
      for (const c of n.children) {
        const t = firstText(c);
        if (t) return t;
      }
      return null;
    }
    const ft = firstText(node);
    return ft ? `box>${JSON.stringify(ft)}` : `box(${node.children.length}ch)`;
  }

  function getMainBoxChildDetails(mainBox: TNode | null) {
    if (!mainBox) return undefined;
    return mainBox.children.map((child) => {
      const hint = getChildHint(child);
      return {
        type: child.type,
        y: child.layout?.y ?? -1,
        height: child.layout?.height ?? -1,
        children: child.children.length,
        hint,
        isSpinner: hint.includes('Thinking'),
      };
    });
  }

  function logFrame(
    type: 'full' | 'growth' | 'update',
    root: TNode,
    ch: number,
    prevCH: number,
    ev: number,
    cols: number,
    rows: number,
    extra?: Partial<FrameLogEntry>,
  ): void {
    const now = Date.now();
    const mainBox = getMainBox(root);
    const entry: FrameLogEntry = {
      ts: now,
      type,
      contentHeight: ch,
      previousContentHeight: prevCH,
      scrollbackRows,
      effectiveViewport: ev,
      cols,
      rows,
      inputNodeY: findInputNodeY(root),
      mainBoxHeight: mainBox?.layout?.height ?? -1,
      mainBoxChildren: mainBox?.children.length ?? 0,
      mainBoxChildDetails: getMainBoxChildDetails(mainBox),
      prevGridInfo: prevGrid ? {
        width: prevGrid.width,
        height: prevGrid.height,
        lastContentRow: lastContentRow(prevGrid),
      } : null,
      msSincePrevFrame: lastFrameTs > 0 ? now - lastFrameTs : undefined,
      prevFrameType: lastFrameType ?? undefined,
      ...extra,
    };
    lastFrameTs = now;
    lastFrameType = type;
    if (frameLog.length >= FRAME_LOG_SIZE) frameLog.shift();
    frameLog.push(entry);
  }

  function processFrame(root: TNode): void {
    const cols = stdout.columns ?? 80;
    const rows = stdout.rows ?? 24;

    layout(root, cols, rows);

    if (isFirstFrame) {
      isFirstFrame = false;
      doFullRedraw(root, cols, rows, 'first-frame');
      return;
    }

    // Rasterize full content into back buffer once.
    // actualHeight from the rasterized grid is the source of truth.
    const ch = contentHeight(root);
    const fullGrid = rasterize(root, cols, Math.max(ch + 10, rows), 0);
    const actualHeight = lastContentRow(fullGrid) + 1;
    const desiredScrollback = Math.max(0, actualHeight - rows);

    if (desiredScrollback < scrollbackRows) {
      // Scrollback contains rows that no longer exist — must clear and rebuild
      doFullRedraw(root, cols, rows, 'content-shrink');
      return;
    }

    if (desiredScrollback > scrollbackRows) {
      // Content grew past viewport — growth frame
      doGrowthFrame(root, cols, rows, fullGrid, actualHeight, desiredScrollback);
      return;
    }

    // No scrollback change — update frame
    doUpdateFrame(root, cols, rows, fullGrid, actualHeight, desiredScrollback);
  }

  function doFullRedraw(
    root: TNode,
    cols: number,
    rows: number,
    reason: string = 'unknown',
  ): void {
    // Reset stale state — growthInner sets the real scrollbackRows value below
    scrollbackRows = 0;
    prevGrid = null;

    const ch = contentHeight(root);
    logFrame('full', root, ch, 0, rows, cols, rows, {
      fullRedrawReason: reason,
    });

    if (ch <= 0) {
      // Nothing to draw — just clear
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

    // Write 1: clear screen + scrollback + sequential content write.
    const clearAndScroll = DEC_2026_ON + CLEAR_SCREEN_SCROLLBACK_HOME + CURSOR_HIDE + scrollSeq + DEC_2026_OFF;
    let ok = stdout.write(clearAndScroll);
    if (!ok) isFlushing = true;

    // Write 2: viewport fullRedraw in its own DEC 2026 block.
    const redrawOutput = DEC_2026_ON + redrawSeq + DEC_2026_OFF;
    ok = stdout.write(redrawOutput);
    if (!ok) isFlushing = true;
  }

  function doGrowthFrame(
    root: TNode,
    cols: number,
    rows: number,
    fullGrid: CellGrid,
    actualHeight: number,
    desiredScrollback: number,
  ): void {
    logFrame('growth', root, actualHeight, 0, rows, cols, rows);

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
    root: TNode,
    cols: number,
    rows: number,
    fullGrid: CellGrid,
    actualHeight: number,
    desiredScrollback: number,
  ): void {
    scrollbackRows = desiredScrollback;

    // Log BEFORE diff so prevGridInfo captures the grid from the previous frame
    logFrame('update', root, actualHeight, 0, rows, cols, rows);

    const viewportGrid = extractViewport(fullGrid, scrollbackRows, rows);

    let result: { output: string; endRow: number; endCol: number };
    if (prevGrid === null) {
      // prevGrid is null after resize — fall back to full viewport redraw
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
    // The timer is NEVER reset — new commits just update pendingRoot.
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

    // Cancel any pending frame — resize does its own full redraw
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

      doFullRedraw(lastRoot, cols, rows, 'resize');
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
      // Kill flush guard state — teardown is unconditional, not a frame.
      if (frameTimer !== null) {
        clearTimeout(frameTimer);
        frameTimer = null;
      }
      isFlushing = false;
      pendingRoot = null;
      // Move cursor to bottom of viewport and advance past rendered content
      // so the shell prompt appears on its own line.
      const rows = stdout.rows ?? 24;
      writeFileSync(1, `\x1b[${rows};1H\n` + CURSOR_SHOW);
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
      const data = JSON.stringify(frameLog, null, 2);
      writeFileSync(path, data);
    },
  };
}
