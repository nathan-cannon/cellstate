/** Compares growth frame cost (scrollback push + redraw) vs normal update frame (diff only). */
import { layout, contentHeight, clearLayout } from '../../src/core/layout.js';
import { rasterize } from '../../src/core/rasterizer.js';
import { diff, fullRedraw, extractViewport, lastContentRow, serializeRowRange } from '../../src/core/diff.js';
import { buildChatTree } from '../content.js';
import { measure, computeStats, fmtMs, printTable } from '../harness.js';

const COLS = 120;
const ROWS = 40;
const MESSAGE_COUNTS = [10, 50, 100, 250, 500, 1000];
const ITERATIONS = 200;
const WARMUP = 20;

export async function runGrowthFrame(): Promise<void> {
  const rows: string[][] = [];

  for (const msgCount of MESSAGE_COUNTS) {
    // Build "before" state — content at current size
    const treeBefore = buildChatTree(msgCount, 0);
    layout(treeBefore, COLS, ROWS);
    const chBefore = contentHeight(treeBefore);
    const fullHeightBefore = Math.max(chBefore + 10, ROWS);
    const fullGridBefore = rasterize(treeBefore, COLS, fullHeightBefore, 0);
    const actualBefore = lastContentRow(fullGridBefore) + 1;
    const scrollBefore = Math.max(0, actualBefore - ROWS);

    // Build "after" state — add streaming text to grow content
    const treeAfter = buildChatTree(msgCount, 0, 'extra streaming content that adds a new line to trigger growth');
    layout(treeAfter, COLS, ROWS);
    const chAfter = contentHeight(treeAfter);
    const fullHeightAfter = Math.max(chAfter + 10, ROWS);
    const fullGridAfter = rasterize(treeAfter, COLS, fullHeightAfter, 0);
    const actualAfter = lastContentRow(fullGridAfter) + 1;
    const scrollAfter = Math.max(0, actualAfter - ROWS);
    const scrollNeeded = Math.max(0, scrollAfter - scrollBefore);

    // Viewport grids for update-frame diff
    const vpBefore = extractViewport(fullGridBefore, scrollBefore, ROWS);
    const vpAfter = extractViewport(fullGridAfter, scrollAfter, ROWS);

    // 1. Measure rasterize (growth frame still needs full rasterize)
    const rasterLat = measure(() => {
      rasterize(treeAfter, COLS, fullHeightAfter, 0);
    }, ITERATIONS, WARMUP);

    // 2. Measure serializeRowRange (rows entering scrollback)
    let serializeLat: number[];
    let serializeBytes = 0;
    if (scrollNeeded > 0) {
      const result = serializeRowRange(fullGridAfter, scrollBefore, scrollBefore + scrollNeeded);
      serializeBytes = result.output.length;
      serializeLat = measure(() => {
        serializeRowRange(fullGridAfter, scrollBefore, scrollBefore + scrollNeeded);
      }, ITERATIONS, WARMUP);
    } else {
      serializeLat = [0];
    }

    // 3. Measure extractViewport
    const extractLat = measure(() => {
      extractViewport(fullGridAfter, scrollAfter, ROWS);
    }, ITERATIONS, WARMUP);

    // 4. Measure fullRedraw (growth frames always do full redraw)
    const redrawResult = fullRedraw(vpAfter, 0);
    const redrawBytes = redrawResult.output.length;
    const redrawLat = measure(() => {
      fullRedraw(vpAfter, 0);
    }, ITERATIONS, WARMUP);

    // 5. Measure normal update frame (diff only) at same content size
    const diffLat = measure(() => {
      diff(vpBefore, vpAfter, 0, 0);
    }, ITERATIONS, WARMUP);

    const rasterMs = computeStats(rasterLat).median;
    const serializeMs = computeStats(serializeLat).median;
    const extractMs = computeStats(extractLat).median;
    const redrawMs = computeStats(redrawLat).median;
    const diffMs = computeStats(diffLat).median;

    const growthTotal = rasterMs + serializeMs + extractMs + redrawMs;
    const updateTotal = rasterMs + extractMs + diffMs;
    const ratio = updateTotal > 0 ? growthTotal / updateTotal : 0;

    rows.push([
      String(msgCount),
      fmtMs(rasterMs),
      fmtMs(serializeMs),
      fmtMs(extractMs),
      fmtMs(redrawMs),
      fmtMs(growthTotal),
      fmtMs(diffMs),
      fmtMs(updateTotal),
      `${ratio.toFixed(1)}x`,
      String(serializeBytes + redrawBytes),
    ]);
  }

  printTable(
    'Growth Frame vs Update Frame',
    ['Messages', 'rasterize', 'serialize', 'extract', 'fullRedraw', 'GROWTH', 'diff', 'UPDATE', 'Ratio', 'Bytes'],
    rows,
  );
}

// Allow running standalone
if (process.argv[1]?.endsWith('growth-frame.ts')) {
  runGrowthFrame();
}
