/** Compares growth frame cost vs normal update frame using viewport diff approach. */
import { createCellBuffer, lastNonBlankRow, viewportSlice, expandDamageForShrink, type CellBuffer } from '../../src/core/cell-buffer.js';
import { CharTable } from '../../src/core/char-table.js';
import { StyleTable } from '../../src/core/style-table.js';
import { LinkTable } from '../../src/core/link-table.js';
import { paintTree } from '../../src/core/paint.js';
import { diffBuffers } from '../../src/core/emit.js';
import { createFlexNodeFactory } from '../../src/layout/yoga-flex.js';
import { buildChatTree } from '../content.js';
import { measure, computeStats, fmtMs, printTable } from '../harness.js';

const COLS = 120;
const ROWS = 40;
const MESSAGE_COUNTS = [10, 50, 100, 250, 500, 1000];
const ITERATIONS = 200;
const WARMUP = 20;

function doLayout(tree: any, cols: number): void {
  tree.flexNode!.setWidth(cols);
  tree.flexNode!.calculateLayout(cols);
}

export async function runGrowthFrame(): Promise<void> {
  const rows: string[][] = [];
  const factory = createFlexNodeFactory();

  for (const msgCount of MESSAGE_COUNTS) {
    const charTable = new CharTable();
    const styleTable = new StyleTable();
    const linkTable = new LinkTable();

    // Build "before" state — content at current size
    const treeBefore = buildChatTree(msgCount, 0, undefined, factory);
    doLayout(treeBefore, COLS);
    const chBefore = treeBefore.flexNode!.getComputedHeight();
    const bufHeightBefore = Math.max(chBefore, ROWS);
    const frontBuf = createCellBuffer(COLS, bufHeightBefore);
    paintTree(treeBefore, frontBuf, null, charTable, styleTable, linkTable, 0);

    // Build "after" state — add streaming text to grow content
    const treeAfter = buildChatTree(msgCount, 0, 'extra streaming content that adds a new line to trigger growth', factory);
    doLayout(treeAfter, COLS);
    const chAfter = treeAfter.flexNode!.getComputedHeight();
    const bufHeightAfter = Math.max(chAfter, ROWS);

    // Build "update" state — same height as "before", different counter
    const treeUpdate = buildChatTree(msgCount, 1, undefined, factory);
    doLayout(treeUpdate, COLS);

    // Use the larger buffer height for ALL paint measurements so the
    // growth vs update comparison isolates emit cost, not buffer size.
    const sharedBufHeight = bufHeightAfter;

    // Paint "after" and "update" trees into same-sized buffers
    const backBufGrowth = createCellBuffer(COLS, sharedBufHeight);
    paintTree(treeAfter, backBufGrowth, null, charTable, styleTable, linkTable, 0);

    const backBufUpdate = createCellBuffer(COLS, sharedBufHeight);
    paintTree(treeUpdate, backBufUpdate, null, charTable, styleTable, linkTable, 0);

    // Run expandDamageForShrink once to set up damage for viewport slicing
    expandDamageForShrink(frontBuf, backBufGrowth);
    const frontStartGrowth = Math.max(0, frontBuf.height - ROWS);
    const backStartGrowth = Math.max(0, backBufGrowth.height - ROWS);
    const frontVpGrowth = viewportSlice(frontBuf, frontStartGrowth, ROWS);
    const backVpGrowth = viewportSlice(backBufGrowth, backStartGrowth, ROWS);

    expandDamageForShrink(frontBuf, backBufUpdate);
    const frontStartUpdate = Math.max(0, frontBuf.height - ROWS);
    const backStartUpdate = Math.max(0, backBufUpdate.height - ROWS);
    const frontVpUpdate = viewportSlice(frontBuf, frontStartUpdate, ROWS);
    const backVpUpdate = viewportSlice(backBufUpdate, backStartUpdate, ROWS);

    // Pre-allocate buffer pools so paint measurements exclude allocation
    const growthBufs: CellBuffer[] = [];
    const updateBufs: CellBuffer[] = [];
    for (let i = 0; i < ITERATIONS + WARMUP; i++) {
      growthBufs.push(createCellBuffer(COLS, sharedBufHeight));
      updateBufs.push(createCellBuffer(COLS, sharedBufHeight));
    }

    // Measure paint for growth tree (cold, no front buffer)
    const paintGrowthLat = measure(() => {
      const buf = growthBufs.pop() ?? createCellBuffer(COLS, sharedBufHeight);
      paintTree(treeAfter, buf, null, charTable, styleTable, linkTable, 0);
    }, ITERATIONS, WARMUP);

    // Measure paint for update tree (cold, no front buffer)
    const paintUpdateLat = measure(() => {
      const buf = updateBufs.pop() ?? createCellBuffer(COLS, sharedBufHeight);
      paintTree(treeUpdate, buf, null, charTable, styleTable, linkTable, 0);
    }, ITERATIONS, WARMUP);

    // Measure expandDamageForShrink for growth frame
    const expandGrowthLat = measure(() => {
      const eFront = createCellBuffer(COLS, bufHeightBefore);
      paintTree(treeBefore, eFront, null, charTable, styleTable, linkTable, 0);
      const eBack = createCellBuffer(COLS, sharedBufHeight);
      paintTree(treeAfter, eBack, null, charTable, styleTable, linkTable, 0);
      expandDamageForShrink(eFront, eBack);
    }, ITERATIONS, WARMUP);
    const expandGrowthBaseLat = measure(() => {
      const eFront = createCellBuffer(COLS, bufHeightBefore);
      paintTree(treeBefore, eFront, null, charTable, styleTable, linkTable, 0);
      const eBack = createCellBuffer(COLS, sharedBufHeight);
      paintTree(treeAfter, eBack, null, charTable, styleTable, linkTable, 0);
    }, ITERATIONS, WARMUP);
    const expandGrowthOnlyLat = expandGrowthLat.map((v, i) => Math.max(0, v - (expandGrowthBaseLat[i] ?? 0)));

    // Measure expandDamageForShrink for update frame
    const expandUpdateLat = measure(() => {
      const eFront = createCellBuffer(COLS, bufHeightBefore);
      paintTree(treeBefore, eFront, null, charTable, styleTable, linkTable, 0);
      const eBack = createCellBuffer(COLS, sharedBufHeight);
      paintTree(treeUpdate, eBack, null, charTable, styleTable, linkTable, 0);
      expandDamageForShrink(eFront, eBack);
    }, ITERATIONS, WARMUP);
    const expandUpdateBaseLat = measure(() => {
      const eFront = createCellBuffer(COLS, bufHeightBefore);
      paintTree(treeBefore, eFront, null, charTable, styleTable, linkTable, 0);
      const eBack = createCellBuffer(COLS, sharedBufHeight);
      paintTree(treeUpdate, eBack, null, charTable, styleTable, linkTable, 0);
    }, ITERATIONS, WARMUP);
    const expandUpdateOnlyLat = expandUpdateLat.map((v, i) => Math.max(0, v - (expandUpdateBaseLat[i] ?? 0)));

    // Measure diffBuffers for growth frame
    const growthDiffLat = measure(() => {
      diffBuffers(frontVpGrowth, backVpGrowth, styleTable, charTable, linkTable, false);
    }, ITERATIONS, WARMUP);

    // Measure diffBuffers for update frame
    const updateDiffLat = measure(() => {
      diffBuffers(frontVpUpdate, backVpUpdate, styleTable, charTable, linkTable, false);
    }, ITERATIONS, WARMUP);

    // Get output sizes (single sample for metadata)
    const growthBytes = diffBuffers(frontVpGrowth, backVpGrowth, styleTable, charTable, linkTable, false).length;
    const updateBytes = diffBuffers(frontVpUpdate, backVpUpdate, styleTable, charTable, linkTable, false).length;

    const paintGrowthMs = computeStats(paintGrowthLat).median;
    const paintUpdateMs = computeStats(paintUpdateLat).median;
    const expandGrowthMs = computeStats(expandGrowthOnlyLat).median;
    const expandUpdateMs = computeStats(expandUpdateOnlyLat).median;
    const growthDiffMs = computeStats(growthDiffLat).median;
    const updateDiffMs = computeStats(updateDiffLat).median;

    const growthTotal = paintGrowthMs + expandGrowthMs + growthDiffMs;
    const updateTotal = paintUpdateMs + expandUpdateMs + updateDiffMs;
    const ratio = updateTotal > 0 ? growthTotal / updateTotal : 0;

    rows.push([
      String(msgCount),
      fmtMs(paintGrowthMs),
      fmtMs(paintUpdateMs),
      fmtMs(expandGrowthMs),
      fmtMs(expandUpdateMs),
      fmtMs(growthDiffMs),
      fmtMs(growthTotal),
      fmtMs(updateDiffMs),
      fmtMs(updateTotal),
      `${ratio.toFixed(1)}x`,
      `${growthBytes}/${updateBytes}`,
    ]);
  }

  printTable(
    'Growth Frame vs Update Frame',
    ['Messages', 'paint(grow)', 'paint(upd)', 'expand(grow)', 'expand(upd)', 'Growth diff', 'GROWTH', 'Update diff', 'UPDATE', 'Ratio', 'Bytes G/U'],
    rows,
  );
}

// Allow running standalone
if (process.argv[1]?.endsWith('growth-frame.ts')) {
  runGrowthFrame();
}
