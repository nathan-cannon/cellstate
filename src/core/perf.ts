/**
 * Lightweight in-memory performance instrumentation for the render pipeline.
 *
 * When disabled, every method is a no-op with near-zero overhead (just a
 * function-call + early return on a boolean check).  No logging, no file
 * writes, no allocation in the hot path.
 *
 * Usage:
 *   const p = createPerf(true);
 *   p.count('frames');
 *   p.timeStart('layout');
 *   // ... work ...
 *   p.timeEnd('layout');
 *   const snap = p.snapshot();
 */

import { writeFileSync } from 'node:fs';

// ── Snapshot types ────────────────────────────────────────────────

/** Counter fields accumulated across frames. */
export interface PerfCounts {
  // Frame totals
  frames: number;
  framesUpdate: number;
  framesGrowth: number;
  framesFullRedraw: number;
  framesSkipped: number;          // update frames where diff output was empty

  // Frame loop I/O
  bytesWritten: number;           // total bytes emitted to stdout
  bytesFullRedraw: number;
  bytesGrowth: number;
  bytesUpdate: number;
  drainWaits: number;             // stdout backpressure events

  // Grid creation (createGrid in cell.ts)
  createGridCalls: number;
  createGridRows: number;
  createGridCells: number;

  // Viewport extraction (extractViewport in diff.ts)
  extractViewportCalls: number;
  extractViewportRowsCopied: number;
  extractViewportCellsCopied: number;
  extractViewportBlankRows: number;

  // Diff engine (diff in diff.ts)
  diffCalls: number;
  diffRowsCompared: number;
  diffRowsSkipped: number;
  diffRowsErased: number;
  diffTrailingEraseHits: number;
  diffChangedCells: number;
  diffCursorMoves: number;
  diffStyleDeltas: number;
  diffFullRedrawFallbacks: number;

  // Layout engine
  layoutTextNodes: number;            // layoutTextNode calls
  layoutTextNodesSegmented: number;   // layoutTextNode with segment-based content
  layoutColumnCalls: number;
  layoutRowCalls: number;
  wrapTextCalls: number;
  wrapSegmentsCalls: number;
  wrapSingleLineCalls: number;
  truncateTextCalls: number;
  wrappedLinesProduced: number;       // total lines output from wrapText
  hardBreaks: number;                 // mid-word breaks in wrapSingleLine
  spaceBreaks: number;                // space-boundary breaks in wrapSingleLine

  // Rasterizer
  walkNodeRoot: number;
  walkNodeBox: number;
  walkNodeText: number;
  walkNodeDivider: number;
  rasterizeTextCalls: number;
  fillBackgroundCalls: number;
  drawBorderCalls: number;
  cellsWritten: number;              // individual cell writes in rasterizeText
  continuationCellsWritten: number;  // wide-char continuation cells
  bgFillCells: number;               // cells set by fillBackground
  borderCells: number;               // cells set by drawBorder

  // Width helpers (counted at callsites in layout/rasterizer)
  stringDisplayWidthCalls: number;
  sliceToWidthCalls: number;
  sliceFromEndToWidthCalls: number;

  // Grapheme cluster events (counted in rasterizeText and wrapSingleLine)
  vs16Upgrades: number;
  skinToneJoins: number;
  regionalIndicatorJoins: number;
  zwjJoins: number;
}

/** Accumulated durations in milliseconds for each pipeline phase. */
export interface PerfTimings {
  // Frame loop (timed from frame-loop.ts)
  layout: number;
  rasterize: number;
  createGrid: number;
  extractViewport: number;
  diff: number;
  serialize: number;
  write: number;

  // Layout sub-phases (timed inside layout.ts)
  layoutTextNode: number;
  layoutColumn: number;
  layoutRow: number;
  truncateText: number;
  wrapSingleLine: number;
  wrapText: number;
  wrapSegments: number;

  // Rasterizer sub-phases (timed inside rasterizer.ts)
  rasterizeText: number;
  fillBackground: number;
  drawBorder: number;
}

/** A point-in-time snapshot returned by `perf.snapshot()`. */
export interface PerfSnapshot {
  enabled: true;
  ts: number;
  elapsed: number;
  counts: Readonly<PerfCounts>;
  timings: Readonly<PerfTimings>;
}

// ── Perf handle ──────────────────────────────────────────────────

export interface Perf {
  /** Whether instrumentation is active. */
  readonly enabled: boolean;

  /** Increment a named counter by `n` (default 1). */
  count(field: keyof PerfCounts, n?: number): void;

  /** Mark the start of a timed phase. */
  timeStart(phase: keyof PerfTimings): void;

  /** Mark the end of a timed phase; accumulates into totals. */
  timeEnd(phase: keyof PerfTimings): void;

  /** Return a frozen snapshot of current counters and timings. */
  snapshot(): PerfSnapshot | null;

  /** Zero all counters and timings; keep enabled state. */
  reset(): void;

  /** Write a JSON snapshot to `path`. No-op when disabled. */
  dumpToFile(path: string): void;
}

// ── Factory ──────────────────────────────────────────────────────

function zeroCounts(): PerfCounts {
  return {
    frames: 0,
    framesUpdate: 0,
    framesGrowth: 0,
    framesFullRedraw: 0,
    framesSkipped: 0,
    bytesWritten: 0,
    bytesFullRedraw: 0,
    bytesGrowth: 0,
    bytesUpdate: 0,
    drainWaits: 0,
    createGridCalls: 0,
    createGridRows: 0,
    createGridCells: 0,
    extractViewportCalls: 0,
    extractViewportRowsCopied: 0,
    extractViewportCellsCopied: 0,
    extractViewportBlankRows: 0,
    diffCalls: 0,
    diffRowsCompared: 0,
    diffRowsSkipped: 0,
    diffRowsErased: 0,
    diffTrailingEraseHits: 0,
    diffChangedCells: 0,
    diffCursorMoves: 0,
    diffStyleDeltas: 0,
    diffFullRedrawFallbacks: 0,
    layoutTextNodes: 0,
    layoutTextNodesSegmented: 0,
    layoutColumnCalls: 0,
    layoutRowCalls: 0,
    wrapTextCalls: 0,
    wrapSegmentsCalls: 0,
    wrapSingleLineCalls: 0,
    truncateTextCalls: 0,
    wrappedLinesProduced: 0,
    hardBreaks: 0,
    spaceBreaks: 0,
    walkNodeRoot: 0,
    walkNodeBox: 0,
    walkNodeText: 0,
    walkNodeDivider: 0,
    rasterizeTextCalls: 0,
    fillBackgroundCalls: 0,
    drawBorderCalls: 0,
    cellsWritten: 0,
    continuationCellsWritten: 0,
    bgFillCells: 0,
    borderCells: 0,
    stringDisplayWidthCalls: 0,
    sliceToWidthCalls: 0,
    sliceFromEndToWidthCalls: 0,
    vs16Upgrades: 0,
    skinToneJoins: 0,
    regionalIndicatorJoins: 0,
    zwjJoins: 0,
  };
}

function zeroTimings(): PerfTimings {
  return {
    layout: 0,
    rasterize: 0,
    createGrid: 0,
    extractViewport: 0,
    diff: 0,
    serialize: 0,
    write: 0,
    layoutTextNode: 0,
    layoutColumn: 0,
    layoutRow: 0,
    truncateText: 0,
    wrapSingleLine: 0,
    wrapText: 0,
    wrapSegments: 0,
    rasterizeText: 0,
    fillBackground: 0,
    drawBorder: 0,
  };
}

/** Disabled singleton: every method is a no-op. */
const DISABLED_PERF: Perf = {
  enabled: false,
  count() {},
  timeStart() {},
  timeEnd() {},
  snapshot() { return null; },
  reset() {},
  dumpToFile() {},
};

/**
 * Create a perf collector.  When `enabled` is false the returned handle
 * is a shared frozen singleton whose methods do nothing.
 */
export function createPerf(enabled: boolean): Perf {
  if (!enabled) return DISABLED_PERF;

  let counts = zeroCounts();
  let timings = zeroTimings();
  const pending = new Map<keyof PerfTimings, number>();
  const startTime = performance.now();

  return {
    enabled: true,

    count(field, n = 1) {
      counts[field] += n;
    },

    timeStart(phase) {
      pending.set(phase, performance.now());
    },

    timeEnd(phase) {
      const t0 = pending.get(phase);
      if (t0 !== undefined) {
        timings[phase] += performance.now() - t0;
        pending.delete(phase);
      }
    },

    snapshot() {
      return {
        enabled: true,
        ts: Date.now(),
        elapsed: performance.now() - startTime,
        counts: { ...counts },
        timings: { ...timings },
      };
    },

    reset() {
      counts = zeroCounts();
      timings = zeroTimings();
      pending.clear();
    },

    dumpToFile(path) {
      const snap = this.snapshot();
      writeFileSync(path, JSON.stringify(snap, null, 2));
    },
  };
}
