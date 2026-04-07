/** Measures createCellBuffer vs clearBuffer (reuse) vs resizeBuffer at various sizes. */
import { createCellBuffer, clearBuffer, resizeBuffer } from '../../src/core/cell-buffer.js';
import { measure, computeStats, fmtMs, printTable } from '../harness.js';

const COLS = 120;
const HEIGHTS = [40, 100, 200, 500, 1000, 2000, 5000];
const ITERATIONS = 200;
const WARMUP = 20;

export async function runBufferOps(): Promise<void> {
  const rows: string[][] = [];

  for (const h of HEIGHTS) {
    // Measure createCellBuffer
    const createLat = measure(() => {
      createCellBuffer(COLS, h);
    }, ITERATIONS, WARMUP);

    // Measure clearBuffer (reuse)
    const buf = createCellBuffer(COLS, h);
    const clearLat = measure(() => {
      clearBuffer(buf);
    }, ITERATIONS, WARMUP);

    // Measure resizeBuffer (reuse path — same dimensions every time)
    let spare = createCellBuffer(COLS, h);
    const resizeReuseLat = measure(() => {
      spare = resizeBuffer(spare, COLS, h);
    }, ITERATIONS, WARMUP);

    // Measure resizeBuffer (grow path — force reallocation each iteration)
    const smallH = Math.max(1, Math.floor(h / 2));
    const resizeGrowLat = measure(() => {
      spare = createCellBuffer(COLS, smallH);
      spare = resizeBuffer(spare, COLS, h);
    }, ITERATIONS, WARMUP);

    const createMs = computeStats(createLat).median;
    const clearMs = computeStats(clearLat).median;
    const resizeReuseMs = computeStats(resizeReuseLat).median;
    const resizeGrowMs = computeStats(resizeGrowLat).median;
    const clearSavings = createMs > 0 ? ((createMs - clearMs) / createMs * 100) : 0;
    const resizeReuseSavings = createMs > 0 ? ((createMs - resizeReuseMs) / createMs * 100) : 0;

    // Throughput: GB/s for clearBuffer based on 8 bytes per cell
    const bytes = COLS * h * 8;
    const clearSeconds = clearMs / 1000;
    const clearGBps = clearSeconds > 0 ? bytes / (clearSeconds * 1e9) : 0;

    rows.push([
      `${COLS}×${h}`,
      String(COLS * h),
      fmtMs(createMs),
      fmtMs(clearMs),
      `${clearSavings.toFixed(0)}%`,
      fmtMs(resizeReuseMs),
      `${resizeReuseSavings.toFixed(0)}%`,
      fmtMs(resizeGrowMs),
      `${clearGBps.toFixed(1)}`,
    ]);
  }

  printTable(
    'Buffer Allocation — createCellBuffer vs clearBuffer vs resizeBuffer',
    ['Dimensions', 'Cells', 'create', 'clear', 'Clear savings', 'resize(reuse)', 'Reuse savings', 'resize(grow)', 'Clear GB/s'],
    rows,
  );
}

// Allow running standalone
if (process.argv[1]?.endsWith('buffer-ops.ts')) {
  runBufferOps();
}
