/** Measures each pipeline stage in isolation at increasing message counts. */
import { performance } from 'node:perf_hooks';
import { createGrid, ColorMode, type CellGrid } from '../../src/core/cell.js';
import { layout, contentHeight, clearLayout } from '../../src/core/layout.js';
import { rasterize } from '../../src/core/rasterizer.js';
import { diff, extractViewport, lastContentRow } from '../../src/core/diff.js';
import { buildChatTree, inputLineText } from '../content.js';
import { measure, computeStats, fmtMs, printTable } from '../harness.js';

const COLS = 120;
const ROWS = 40;
const MESSAGE_COUNTS = [10, 50, 100, 250, 500, 1000];
const ITERATIONS = 200;
const WARMUP = 20;

export async function runPipelineBreakdown(): Promise<void> {
  const rows: string[][] = [];
  const metaRows: string[][] = [];

  for (const msgCount of MESSAGE_COUNTS) {
    // Build tree and run pipeline once to get dimensions
    const tree = buildChatTree(msgCount, 0);
    layout(tree, COLS, ROWS);
    const ch = contentHeight(tree);
    const fullHeight = Math.max(ch + 10, ROWS);
    const fullGrid = rasterize(tree, COLS, fullHeight, 0);
    const actualHeight = lastContentRow(fullGrid) + 1;
    const scrollOffset = Math.max(0, actualHeight - ROWS);

    // Build "before" and "after" viewport grids for diff benchmark
    const viewportBefore = extractViewport(fullGrid, scrollOffset, ROWS);

    // Build tree with counter=1 for the "after" state
    const tree1 = buildChatTree(msgCount, 1);
    layout(tree1, COLS, ROWS);
    const ch1 = contentHeight(tree1);
    const fullHeight1 = Math.max(ch1 + 10, ROWS);
    const fullGrid1 = rasterize(tree1, COLS, fullHeight1, 0);
    const actualHeight1 = lastContentRow(fullGrid1) + 1;
    const scrollOffset1 = Math.max(0, actualHeight1 - ROWS);
    const viewportAfter = extractViewport(fullGrid1, scrollOffset1, ROWS);

    // Measure layout
    const layoutLat = measure(() => {
      clearLayout(tree);
      layout(tree, COLS, ROWS);
    }, ITERATIONS, WARMUP);

    // Measure createGrid
    const gridLat = measure(() => {
      createGrid(COLS, fullHeight);
    }, ITERATIONS, WARMUP);

    // Measure rasterize (includes createGrid)
    const rasterLat = measure(() => {
      rasterize(tree, COLS, fullHeight, 0);
    }, ITERATIONS, WARMUP);

    // Measure lastContentRow
    const lastRowLat = measure(() => {
      lastContentRow(fullGrid);
    }, ITERATIONS, WARMUP);

    // Measure extractViewport
    const extractLat = measure(() => {
      extractViewport(fullGrid, scrollOffset, ROWS);
    }, ITERATIONS, WARMUP);

    // Measure diff (single cell change)
    const diff1Lat = measure(() => {
      diff(viewportBefore, viewportAfter, 0, 0);
    }, ITERATIONS, WARMUP);

    // Measure diff (identical)
    const diffEqLat = measure(() => {
      diff(viewportBefore, viewportBefore, 0, 0);
    }, ITERATIONS, WARMUP);

    const layoutMs = computeStats(layoutLat).median;
    const gridMs = computeStats(gridLat).median;
    const rasterMs = computeStats(rasterLat).median;
    const lastRowMs = computeStats(lastRowLat).median;
    const extractMs = computeStats(extractLat).median;
    const diff1Ms = computeStats(diff1Lat).median;
    const diffEqMs = computeStats(diffEqLat).median;
    const total = layoutMs + rasterMs + lastRowMs + extractMs + diff1Ms;

    rows.push([
      String(msgCount),
      fmtMs(layoutMs),
      fmtMs(gridMs),
      fmtMs(rasterMs),
      fmtMs(lastRowMs),
      fmtMs(extractMs),
      fmtMs(diff1Ms),
      fmtMs(diffEqMs),
      fmtMs(total),
    ]);

    metaRows.push([
      String(msgCount),
      String(ch),
      String(fullHeight),
      String(actualHeight),
      String(scrollOffset),
    ]);
  }

  printTable(
    `Pipeline Breakdown — ${COLS}×${ROWS} viewport`,
    ['Messages', 'layout', 'createGrid', 'rasterize', 'lastRow', 'extract', 'diff(1)', 'diff(=)', 'TOTAL'],
    rows,
  );

  printTable(
    'Grid Dimensions',
    ['Messages', 'contentHeight', 'fullGridHeight', 'actualHeight', 'scrollbackRows'],
    metaRows,
  );
}

// Allow running standalone
if (process.argv[1]?.endsWith('pipeline-breakdown.ts')) {
  runPipelineBreakdown();
}
