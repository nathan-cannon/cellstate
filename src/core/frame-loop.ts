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
  clearBuffer,
  resizeBuffer,
  lastNonBlankRow,
  viewportSlice,
  expandDamageForShrink,
} from './cell-buffer.js';
import { CharTable } from './char-table.js';
import { StyleTable } from './style-table.js';
import { LinkTable } from './link-table.js';
import {
  diffBuffers,
  serializeAll,
  serializeRowRange,
  serializeNewRows,
  serializeRowsForExit,
} from './emit.js';
import { readCell, WIDE_WIDTH, CONTINUATION_WIDTH } from './cell-buffer.js';
import { mountRoot } from './reconciler.js';
import { writeFileSync } from 'node:fs';
import { detectCapabilities, type TerminalCapabilities } from './capabilities.js';
import { createPerf, type Perf, type PerfSnapshot } from './perf.js';

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

  // --- Interning tables (session lifetime) ---
  const charTable = new CharTable();
  const styleTable = new StyleTable();
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
  let scrollbackRows = 0;
  let contaminated = false;
  /** When true, the next full-redraw frame prepends an erase-screen sequence
   *  inside the atomic BSU/ESU block so old content stays visible until the
   *  new frame swaps in atomically. */
  let eraseOnNextFrame = false;
  /** Viewport rows from the most recent processFrame, for getGrid(). */
  let lastViewportRows = 0;

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

  // --- Full-redraw path ---

  /**
   * Full redraw: setup scrollback (pre-paint + push), viewport redraw.
   * Used for first frame, resize, stale scrollback, and contamination.
   * Emits a single stdout.write() inside one atomic BSU/ESU block.
   * The erase sequence is only included when eraseOnNextFrame is true.
   */
  function handleFullRedraw(
    backBuffer: CellBuffer,
    desiredScrollback: number,
    rows: number,
  ): void {
    scrollbackRows = 0;

    // --- Erase (conditional) ---
    const erase = eraseOnNextFrame ? CLEAR_SCREEN_SCROLLBACK_HOME : '';
    eraseOnNextFrame = false;

    // --- Scrollback setup ---
    const scrollNeeded = desiredScrollback;
    let scrollSeq = '';

    if (scrollNeeded > 0) {
      let offset = 0;
      let remaining = scrollNeeded;

      perf.timeStart('serialize');
      while (remaining > 0) {
        const batch = Math.min(remaining, rows);

        scrollSeq += '\x1b[H';
        scrollSeq += serializeRowRange(backBuffer, offset, offset + batch, styleTable, charTable, linkTable, hyperlinksEnabled).output;

        scrollSeq += `\x1b[${rows};1H`;
        scrollSeq += '\n'.repeat(batch);

        offset += batch;
        remaining -= batch;
      }
      perf.timeEnd('serialize');
      scrollbackRows = desiredScrollback;
    }

    // --- Viewport redraw ---
    const vpSlice = viewportSlice(backBuffer, scrollbackRows, rows);
    perf.timeStart('serialize');
    const body = serializeAll(vpSlice, styleTable, charTable, linkTable, hyperlinksEnabled);
    perf.timeEnd('serialize');
    const redrawSeq = '\x1b[H\x1b[0m' + body.output;

    // Single atomic BSU/ESU block: erase + cursor hide + scroll + viewport
    const frame = DEC_2026_ON + erase + CURSOR_HIDE + scrollSeq + redrawSeq + DEC_2026_OFF;
    perf.count('bytesWritten', frame.length);
    perf.count('bytesFullRedraw', frame.length);
    perf.timeStart('write');
    const ok = stdout.write(frame);
    perf.timeEnd('write');
    if (!ok) { isFlushing = true; perf.count('drainWaits'); }

    // Set front buffer
    spareRef = frontRef;
    frontRef = backBuffer;
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
    const rows = stdout.rows ?? 24;
    lastViewportRows = rows;

    perf.timeStart('layout');
    root.flexNode!.setWidth(cols);
    root.flexNode!.calculateLayout(cols);
    perf.timeEnd('layout');

    const ch = root.flexNode!.getComputedHeight();
    const cw = root.flexNode!.getComputedWidth();

    // --- Yoga dimension validation ──────────────────────────────────────
    // NaN/Infinity can escape Yoga during rapid resize; NaN <= 0 is false
    // in JS so the existing ch <= 0 guard doesn't catch it. Validate both
    // axes before any allocation.
    if (!Number.isFinite(ch) || ch < 0 || !Number.isFinite(cw) || cw < 0) {
      if (process.env.DEBUG) {
        process.stderr.write(
          `[FRAME] bad yoga dimensions: width=${cw} height=${ch}\n`,
        );
      }
      scrollbackRows = 0;
      eraseOnNextFrame = false;
      contaminated = false;
      isFirstFrame = false;
      const output = DEC_2026_ON + CLEAR_SCREEN_SCROLLBACK_HOME + CURSOR_HIDE + DEC_2026_OFF;
      perf.timeStart('write');
      const ok = stdout.write(output);
      perf.timeEnd('write');
      perf.count('bytesWritten', output.length);
      if (!ok) { isFlushing = true; perf.count('drainWaits'); }
      frontRef = null;
      return;
    }

    // --- Full-redraw gates (checked before classify) ---

    const needsFullRedraw = isFirstFrame || frontRef === null || contaminated;
    if (needsFullRedraw) {
      // First frame and contamination both require an erase
      if (isFirstFrame || contaminated) {
        eraseOnNextFrame = true;
      }
      isFirstFrame = false;
      contaminated = false;
      perf.count('framesFullRedraw');

      if (ch <= 0) {
        scrollbackRows = 0;
        eraseOnNextFrame = false;
        const output = DEC_2026_ON + CLEAR_SCREEN_SCROLLBACK_HOME + CURSOR_HIDE + DEC_2026_OFF;
        perf.timeStart('write');
        const ok = stdout.write(output);
        perf.timeEnd('write');
        perf.count('bytesWritten', output.length);
        perf.count('bytesFullRedraw', output.length);
        if (!ok) { isFlushing = true; perf.count('drainWaits'); }
        frontRef = null;
        return;
      }

      const bufHeight = Math.max(ch, rows);
      perf.timeStart('rasterize');
      const backBuffer = prepareBackBuffer(cols, bufHeight);
      paintTree(root, backBuffer, null, charTable, styleTable, linkTable, 0, perfOrUndef);
      perf.timeEnd('rasterize');
      const actualHeight = lastNonBlankRow(backBuffer) + 1;
      const desiredScrollback = Math.max(0, actualHeight - rows);

      handleFullRedraw(backBuffer, desiredScrollback, rows);
      return;
    }

    // --- Paint into back buffer ---
    const bufHeight = Math.max(ch, rows);
    perf.timeStart('rasterize');
    const backBuffer = prepareBackBuffer(cols, bufHeight);
    paintTree(root, backBuffer, frontRef, charTable, styleTable, linkTable, 0, perfOrUndef);
    perf.timeEnd('rasterize');
    const actualHeight = lastNonBlankRow(backBuffer) + 1;
    const desiredScrollback = Math.max(0, actualHeight - rows);


    // --- Stale scrollback → full redraw ---
    if (desiredScrollback < scrollbackRows) {
      perf.count('framesFullRedraw');
      eraseOnNextFrame = true;
      handleFullRedraw(backBuffer, desiredScrollback, rows);
      return;
    }

    // --- Expand damage for content shrink ---
    // When content shrinks, rows that are blank in back but had content in
    // front need to be within the damage bounds for the diff to emit erase.
    expandDamageForShrink(frontRef!, backBuffer);

    // --- Log damage dimensions ---
    if (process.env.DEBUG && backBuffer.damageBox) {
      const d = backBuffer.damageBox;
      const w = d.maxCol - d.minCol + 1;
      const h = d.maxRow - d.minRow + 1;
      process.stderr.write(`[FRAME] damage=${w}x${h}+${d.minCol}+${d.minRow}\n`);
    } else if (process.env.DEBUG) {
      process.stderr.write('[FRAME] damage=none\n');
    }

    // --- Unified emit path ---

    const growthPush = desiredScrollback - scrollbackRows;
    const isGrowing = growthPush > 0;

    // Track damage perf counters
    if (perfOrUndef && backBuffer.damageBox) {
      const d = backBuffer.damageBox;
      const damageCells = (d.maxRow - d.minRow + 1) * (d.maxCol - d.minCol + 1);
      const viewportCells = rows * cols;
      perfOrUndef.count('damageCells', damageCells);
      perfOrUndef.count('damageSkippedCells', Math.max(0, viewportCells - damageCells));
    }

    if (!isGrowing) {
      // --- No growth: diff viewport ---
      perf.count('framesUpdate');
      const backVp = viewportSlice(backBuffer, desiredScrollback, rows);
      const frontVp = viewportSlice(frontRef!, scrollbackRows, rows);
      const patch = diffBuffers(frontVp, backVp, styleTable, charTable, linkTable, hyperlinksEnabled, perfOrUndef);

      spareRef = frontRef;
      frontRef = backBuffer;
      scrollbackRows = desiredScrollback;

      if (patch.length === 0) {
        perf.count('framesSkipped');
        return;
      }

      const frame = DEC_2026_ON + '\x1b[H' + patch + DEC_2026_OFF;
      perf.count('bytesWritten', frame.length);
      perf.count('bytesUpdate', frame.length);
      perf.timeStart('write');
      const ok = stdout.write(frame);
      perf.timeEnd('write');
      if (!ok) { isFlushing = true; perf.count('drainWaits'); }
      return;
    }

    // --- Growth path ---
    perf.count('framesGrowth');
    if (perfOrUndef) perfOrUndef.count('growthFrames');

    // --- Scrollback damage guard ---
    // If any damage falls within rows already in scrollback, those rows are
    // unreachable — the terminal doesn't let us edit scrollback in place.
    // Fall back to a full redraw so the content is correct everywhere.
    if (backBuffer.damageBox && scrollbackRows > 0 &&
        backBuffer.damageBox.minRow < scrollbackRows) {
      perf.count('framesFullRedraw');
      eraseOnNextFrame = true;
      handleFullRedraw(backBuffer, desiredScrollback, rows);
      return;
    }

    let output = '';

    // Growth push — serialize new scrollback rows + emit newlines
    perf.timeStart('serialize');
    let offset = scrollbackRows;
    let remaining = growthPush;
    while (remaining > 0) {
      const batch = Math.min(remaining, rows);
      output += '\x1b[H';
      output += serializeRowRange(backBuffer, offset, offset + batch, styleTable, charTable, linkTable, hyperlinksEnabled).output;
      output += `\x1b[${rows};1H`;
      output += '\n'.repeat(batch);
      offset += batch;
      remaining -= batch;
    }
    scrollbackRows = desiredScrollback;

    // Step 4: Diff the viewport against the shifted front.
    // After the growth push, the terminal shows frontRef content shifted up
    // by growthPush rows. The damage-scoped diff handles:
    // - Pure appends (only new rows damaged → diff finds nothing in overlap)
    // - Mixed changes (damage covers affected region → diff processes only that)
    if (desiredScrollback < frontRef!.height && frontRef!.width === cols) {
      const frontVp = viewportSlice(frontRef!, desiredScrollback, rows);
      const backVp = viewportSlice(backBuffer, desiredScrollback, rows);
      const patch = diffBuffers(frontVp, backVp, styleTable, charTable, linkTable, hyperlinksEnabled, perfOrUndef);
      if (patch.length > 0) {
        output += '\x1b[H' + patch;
      }
    } else {
      // Shifted front exceeds bounds — full viewport serialize
      const vpSlice = viewportSlice(backBuffer, scrollbackRows, rows);
      const body = serializeAll(vpSlice, styleTable, charTable, linkTable, hyperlinksEnabled);
      output += '\x1b[H\x1b[0m' + body.output;
    }
    perf.timeEnd('serialize');

    const frame = DEC_2026_ON + output + DEC_2026_OFF;
    perf.count('bytesWritten', frame.length);
    perf.count('bytesGrowth', frame.length);

    spareRef = frontRef;
    frontRef = backBuffer;

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
    eraseOnNextFrame = true;

    // Terminal may restore cursor visibility on resume
    stdout.write(CURSOR_HIDE);

    if (lastRoot !== null) {
      processFrame(lastRoot);
      lastFrameTime = performance.now();
    }
  }

  function onResize(): void {
    const oldScrollback = scrollbackRows;

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
    scrollbackRows = 0;
    contaminated = true; // Forces full-redraw on next processFrame
    eraseOnNextFrame = true; // Defer erase into the atomic output block
    isFirstFrame = false;

    if (lastRoot !== null) {
      if (process.env.DEBUG) {
        const cols = stdout.columns ?? 80;
        const rows = stdout.rows ?? 24;
        process.stderr.write(
          `[RESIZE] cols=${cols} rows=${rows} ` +
          `oldScrollback=${oldScrollback}\n`
        );
      }

      // Process immediately so scrollbackRows is updated synchronously
      // (tests check getScrollbackLines() right after resize).
      // Bypass throttling — resize needs immediate synchronous rendering.
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
      const rows = stdout.rows ?? 24;

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

    /** @deprecated Use getBuffer() with getCharTable()/getStyleTable() instead. */
    getGrid(): CellGrid | null {
      if (!frontRef) return null;
      const vpStart = Math.max(0, scrollbackRows);
      const vpRows = Math.min(lastViewportRows || frontRef.height, frontRef.height - vpStart);
      const buf = viewportSlice(frontRef, vpStart, vpRows);
      // Inline CellBuffer → CellGrid conversion (was compat-bridge.ts)
      const cells: Cell[][] = [];
      for (let r = 0; r < buf.height; r++) {
        const row: Cell[] = [];
        for (let c = 0; c < buf.width; c++) {
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
      return { cells, cursorRow: 0, cursorCol: 0, width: buf.width, height: buf.height };
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
