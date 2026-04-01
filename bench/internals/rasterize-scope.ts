/** Compares full-height rasterize vs viewport-only to quantify clipping savings. */
import { layout, contentHeight } from '../../src/core/layout.js';
import { rasterize } from '../../src/core/rasterizer.js';
import { lastContentRow } from '../../src/core/diff.js';
import { buildChatTree } from '../content.js';
import { measure, computeStats, fmtMs, printTable } from '../harness.js';

const COLS = 120;
const ROWS = 40;
const MESSAGE_COUNTS = [100, 250, 500, 1000];
const ITERATIONS = 200;
const WARMUP = 20;

export async function runRasterizeScope(): Promise<void> {
  const rows: string[][] = [];

  for (const msgCount of MESSAGE_COUNTS) {
    const tree = buildChatTree(msgCount, 0);
    layout(tree, COLS, ROWS);
    const ch = contentHeight(tree);
    const fullHeight = Math.max(ch + 10, ROWS);

    // Compute scroll offset to put viewport at the bottom
    const tempGrid = rasterize(tree, COLS, fullHeight, 0);
    const actualHeight = lastContentRow(tempGrid) + 1;
    const scrollOffset = Math.max(0, actualHeight - ROWS);

    // Full height rasterize (current behavior)
    const fullLat = measure(() => {
      rasterize(tree, COLS, fullHeight, 0);
    }, ITERATIONS, WARMUP);

    // Intermediate height (200 rows)
    const intermediateHeight = 200;
    const intScrollOffset = Math.max(0, actualHeight - intermediateHeight);
    const intLat = measure(() => {
      rasterize(tree, COLS, intermediateHeight, intScrollOffset);
    }, ITERATIONS, WARMUP);

    // Viewport-only (40 rows)
    const vpLat = measure(() => {
      rasterize(tree, COLS, ROWS, scrollOffset);
    }, ITERATIONS, WARMUP);

    const fullMs = computeStats(fullLat).median;
    const intMs = computeStats(intLat).median;
    const vpMs = computeStats(vpLat).median;

    const ratio = vpMs / fullMs;

    rows.push([
      String(msgCount),
      `${fmtMs(fullMs)} (${fullHeight}×${COLS})`,
      `${fmtMs(intMs)} (${intermediateHeight}×${COLS})`,
      `${fmtMs(vpMs)} (${ROWS}×${COLS})`,
      `${(ratio * 100).toFixed(1)}%`,
    ]);
  }

  printTable(
    'Rasterize Scope — viewport-only vs full-height',
    ['Messages', 'Full height', 'Intermediate (200)', 'Viewport only (40)', 'VP/Full ratio'],
    rows,
  );
}

// Allow running standalone
if (process.argv[1]?.endsWith('rasterize-scope.ts')) {
  runRasterizeScope();
}
