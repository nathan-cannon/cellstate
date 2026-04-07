/** Measures each pipeline stage in isolation at increasing message counts. */
import { createCellBuffer, lastNonBlankRow, viewportSlice, expandDamageForShrink, type CellBuffer } from '../../src/core/cell-buffer.js';
import { CharTable } from '../../src/core/char-table.js';
import { StyleTable } from '../../src/core/style-table.js';
import { LinkTable } from '../../src/core/link-table.js';
import { paintTree } from '../../src/core/paint.js';
import { diffBuffers } from '../../src/core/emit.js';
import { createFlexNodeFactory } from '../../src/layout/yoga-flex.js';
import { buildChatTree, buildMarkdownChatTree } from '../content.js';
import { measure, computeStats, fmtMs, printTable } from '../harness.js';

const COLS = 120;
const ROWS = 40;
const MESSAGE_COUNTS = [10, 50, 100, 250, 500, 1000];
const MARKDOWN_MESSAGE_COUNTS = [10, 50, 100, 250];
const ITERATIONS = 200;
const WARMUP = 20;

function doLayout(tree: any, cols: number): void {
  tree.flexNode!.setWidth(cols);
  tree.flexNode!.calculateLayout(cols);
}

export async function runPipelineBreakdown(): Promise<void> {
  const rows: string[][] = [];
  const metaRows: string[][] = [];
  const factory = createFlexNodeFactory();

  for (const msgCount of MESSAGE_COUNTS) {
    const charTable = new CharTable();
    const styleTable = new StyleTable();
    const linkTable = new LinkTable();

    // Build tree and run pipeline once to get dimensions
    const tree = buildChatTree(msgCount, 0, undefined, factory);
    doLayout(tree, COLS);
    const ch = tree.flexNode!.getComputedHeight();
    const bufHeight = Math.max(ch, ROWS);

    // Paint once to get actual content height (first frame, no front buffer)
    let frontBuf = createCellBuffer(COLS, bufHeight);
    paintTree(tree, frontBuf, null, charTable, styleTable, linkTable, 0);
    const actualHeight = lastNonBlankRow(frontBuf) + 1;
    const scrollOffset = Math.max(0, actualHeight - ROWS);

    // Build "after" tree (counter=1) for diff benchmark
    const tree1 = buildChatTree(msgCount, 1, undefined, factory);
    doLayout(tree1, COLS);
    const ch1 = tree1.flexNode!.getComputedHeight();
    const bufHeight1 = Math.max(ch1, ROWS);
    let backBuf = createCellBuffer(COLS, bufHeight1);
    paintTree(tree1, backBuf, null, charTable, styleTable, linkTable, 0);

    // Pre-allocate buffer pools so paint measurements don't include allocation
    const coldBufs: CellBuffer[] = [];
    const blitBufs: CellBuffer[] = [];
    for (let i = 0; i < ITERATIONS + WARMUP; i++) {
      coldBufs.push(createCellBuffer(COLS, bufHeight));
      blitBufs.push(createCellBuffer(COLS, bufHeight));
    }

    // Measure layout
    const layoutLat = measure(() => {
      doLayout(tree, COLS);
    }, ITERATIONS, WARMUP);

    // Measure createCellBuffer
    const bufLat = measure(() => {
      createCellBuffer(COLS, bufHeight);
    }, ITERATIONS, WARMUP);

    // Measure paintTree (cold — no front buffer, full rasterization)
    // Buffer is pre-allocated outside the timing block to isolate paint cost.
    const paintColdLat = measure(() => {
      const buf = coldBufs.pop() ?? createCellBuffer(COLS, bufHeight);
      paintTree(tree, buf, null, charTable, styleTable, linkTable, 0);
    }, ITERATIONS, WARMUP);

    // Measure paintTree (blit — front buffer present, tree is clean after
    // clearAllDirty so canBlit succeeds on every node → full subtree blit)
    // Re-paint frontBuf so dirty flags are cleared on `tree`
    frontBuf = createCellBuffer(COLS, bufHeight);
    paintTree(tree, frontBuf, null, charTable, styleTable, linkTable, 0);
    const paintBlitLat = measure(() => {
      const buf = blitBufs.pop() ?? createCellBuffer(COLS, bufHeight);
      paintTree(tree, buf, frontBuf, charTable, styleTable, linkTable, 0);
    }, ITERATIONS, WARMUP);

    // Measure lastNonBlankRow
    const lastRowLat = measure(() => {
      lastNonBlankRow(frontBuf);
    }, ITERATIONS, WARMUP);

    // Measure viewportSlice
    const sliceLat = measure(() => {
      viewportSlice(frontBuf, scrollOffset, ROWS);
    }, ITERATIONS, WARMUP);

    // Measure expandDamageForShrink (between paint and diff in the real frame loop)
    // Re-paint backBuf fresh each iteration so damage state is realistic
    const expandLat = measure(() => {
      const expandFront = createCellBuffer(COLS, bufHeight);
      paintTree(tree, expandFront, null, charTable, styleTable, linkTable, 0);
      const expandBack = createCellBuffer(COLS, bufHeight1);
      paintTree(tree1, expandBack, null, charTable, styleTable, linkTable, 0);
      expandDamageForShrink(expandFront, expandBack);
    }, ITERATIONS, WARMUP);
    // Subtract the paint cost to isolate expandDamageForShrink
    const paintBaselineLat = measure(() => {
      const expandFront = createCellBuffer(COLS, bufHeight);
      paintTree(tree, expandFront, null, charTable, styleTable, linkTable, 0);
      const expandBack = createCellBuffer(COLS, bufHeight1);
      paintTree(tree1, expandBack, null, charTable, styleTable, linkTable, 0);
    }, ITERATIONS, WARMUP);
    const expandOnlyLat = expandLat.map((v, i) => Math.max(0, v - (paintBaselineLat[i] ?? 0)));

    // Measure diffBuffers (changed content)
    expandDamageForShrink(frontBuf, backBuf);
    const frontVp = viewportSlice(frontBuf, scrollOffset, ROWS);
    const backVp = viewportSlice(backBuf, Math.max(0, (lastNonBlankRow(backBuf) + 1) - ROWS), ROWS);
    const diffChangedLat = measure(() => {
      diffBuffers(frontVp, backVp, styleTable, charTable, linkTable, false);
    }, ITERATIONS, WARMUP);

    // Measure diffBuffers (identical)
    const diffEqLat = measure(() => {
      diffBuffers(frontVp, frontVp, styleTable, charTable, linkTable, false);
    }, ITERATIONS, WARMUP);

    const layoutMs = computeStats(layoutLat).median;
    const bufMs = computeStats(bufLat).median;
    const paintColdMs = computeStats(paintColdLat).median;
    const paintBlitMs = computeStats(paintBlitLat).median;
    const lastRowMs = computeStats(lastRowLat).median;
    const sliceMs = computeStats(sliceLat).median;
    const expandMs = computeStats(expandOnlyLat).median;
    const diffChangedMs = computeStats(diffChangedLat).median;
    const diffEqMs = computeStats(diffEqLat).median;
    // Update frame total: layout + buffer alloc + paint(blit) + lastRow + vpSlice + expand + diff
    const total = layoutMs + bufMs + paintBlitMs + lastRowMs + sliceMs + expandMs + diffChangedMs;

    rows.push([
      String(msgCount),
      fmtMs(layoutMs),
      fmtMs(bufMs),
      fmtMs(paintColdMs),
      fmtMs(paintBlitMs),
      fmtMs(lastRowMs),
      fmtMs(sliceMs),
      fmtMs(expandMs),
      fmtMs(diffChangedMs),
      fmtMs(diffEqMs),
      fmtMs(total),
    ]);

    metaRows.push([
      String(msgCount),
      String(ch),
      String(bufHeight),
      String(actualHeight),
      String(scrollOffset),
    ]);
  }

  printTable(
    `Pipeline Breakdown — ${COLS}×${ROWS} viewport`,
    ['Messages', 'layout', 'createBuf', 'paint(cold)', 'paint(blit)', 'lastRow', 'vpSlice', 'expand', 'diff(Δ)', 'diff(=)', 'TOTAL'],
    rows,
  );

  printTable(
    'Buffer Dimensions',
    ['Messages', 'contentHeight', 'bufferHeight', 'actualHeight', 'scrollbackRows'],
    metaRows,
  );

  // ── Markdown pipeline run ──
  const mdRows: string[][] = [];

  for (const msgCount of MARKDOWN_MESSAGE_COUNTS) {
    const charTable = new CharTable();
    const styleTable = new StyleTable();
    const linkTable = new LinkTable();

    const tree = buildMarkdownChatTree(msgCount, factory);
    doLayout(tree, COLS);
    const ch = tree.flexNode!.getComputedHeight();
    const bufHeight = Math.max(ch, ROWS);

    let frontBuf = createCellBuffer(COLS, bufHeight);
    paintTree(tree, frontBuf, null, charTable, styleTable, linkTable, 0);
    const actualHeight = lastNonBlankRow(frontBuf) + 1;
    const scrollOffset = Math.max(0, actualHeight - ROWS);

    // "after" tree — use plain chat tree with counter=1 for diff
    const tree1 = buildMarkdownChatTree(msgCount, factory);
    doLayout(tree1, COLS);
    const ch1 = tree1.flexNode!.getComputedHeight();
    const bufHeight1 = Math.max(ch1, ROWS);
    const backBuf = createCellBuffer(COLS, bufHeight1);
    paintTree(tree1, backBuf, null, charTable, styleTable, linkTable, 0);

    const coldBufs: CellBuffer[] = [];
    const blitBufs: CellBuffer[] = [];
    for (let i = 0; i < ITERATIONS + WARMUP; i++) {
      coldBufs.push(createCellBuffer(COLS, bufHeight));
      blitBufs.push(createCellBuffer(COLS, bufHeight));
    }

    const layoutLat = measure(() => { doLayout(tree, COLS); }, ITERATIONS, WARMUP);

    const bufLat = measure(() => { createCellBuffer(COLS, bufHeight); }, ITERATIONS, WARMUP);

    const paintColdLat = measure(() => {
      const buf = coldBufs.pop() ?? createCellBuffer(COLS, bufHeight);
      paintTree(tree, buf, null, charTable, styleTable, linkTable, 0);
    }, ITERATIONS, WARMUP);

    frontBuf = createCellBuffer(COLS, bufHeight);
    paintTree(tree, frontBuf, null, charTable, styleTable, linkTable, 0);
    const paintBlitLat = measure(() => {
      const buf = blitBufs.pop() ?? createCellBuffer(COLS, bufHeight);
      paintTree(tree, buf, frontBuf, charTable, styleTable, linkTable, 0);
    }, ITERATIONS, WARMUP);

    const lastRowLat = measure(() => { lastNonBlankRow(frontBuf); }, ITERATIONS, WARMUP);

    const sliceLat = measure(() => { viewportSlice(frontBuf, scrollOffset, ROWS); }, ITERATIONS, WARMUP);

    expandDamageForShrink(frontBuf, backBuf);
    const frontVp = viewportSlice(frontBuf, scrollOffset, ROWS);
    const backVp = viewportSlice(backBuf, Math.max(0, (lastNonBlankRow(backBuf) + 1) - ROWS), ROWS);

    const diffChangedLat = measure(() => {
      diffBuffers(frontVp, backVp, styleTable, charTable, linkTable, false);
    }, ITERATIONS, WARMUP);

    const layoutMs = computeStats(layoutLat).median;
    const bufMs = computeStats(bufLat).median;
    const paintColdMs = computeStats(paintColdLat).median;
    const paintBlitMs = computeStats(paintBlitLat).median;
    const lastRowMs = computeStats(lastRowLat).median;
    const sliceMs = computeStats(sliceLat).median;
    const diffChangedMs = computeStats(diffChangedLat).median;
    const total = layoutMs + bufMs + paintBlitMs + lastRowMs + sliceMs + diffChangedMs;

    mdRows.push([
      String(msgCount),
      fmtMs(layoutMs),
      fmtMs(bufMs),
      fmtMs(paintColdMs),
      fmtMs(paintBlitMs),
      fmtMs(lastRowMs),
      fmtMs(sliceMs),
      fmtMs(diffChangedMs),
      fmtMs(total),
    ]);
  }

  printTable(
    `Pipeline Breakdown (Markdown) — ${COLS}×${ROWS} viewport`,
    ['Messages', 'layout', 'createBuf', 'paint(cold)', 'paint(blit)', 'lastRow', 'vpSlice', 'diff(Δ)', 'TOTAL'],
    mdRows,
  );
}

// Allow running standalone
if (process.argv[1]?.endsWith('pipeline-breakdown.ts')) {
  runPipelineBreakdown();
}
