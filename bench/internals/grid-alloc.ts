/** Measures createGrid vs clearGrid (reuse) at various sizes. */
import { createGrid, ColorMode, type CellGrid } from '../../src/core/cell.js';
import { measure, computeStats, fmtMs, printTable } from '../harness.js';

const COLS = 120;
const HEIGHTS = [40, 100, 200, 400, 700, 1000, 2000];
const ITERATIONS = 200;
const WARMUP = 20;

function clearGrid(grid: CellGrid): void {
  for (let r = 0; r < grid.height; r++) {
    for (let c = 0; c < grid.width; c++) {
      const cell = grid.cells[r]![c]!;
      cell.char = ' ';
      cell.width = 1;
      cell.fg.mode = ColorMode.Default;
      cell.fg.value = 0;
      cell.bg.mode = ColorMode.Default;
      cell.bg.value = 0;
      cell.attrs = 0;
    }
  }
}

export async function runGridAlloc(): Promise<void> {
  const rows: string[][] = [];

  for (const h of HEIGHTS) {
    // Measure createGrid
    const createLat = measure(() => {
      createGrid(COLS, h);
    }, ITERATIONS, WARMUP);

    // Measure clearGrid (reuse)
    const grid = createGrid(COLS, h);
    const clearLat = measure(() => {
      clearGrid(grid);
    }, ITERATIONS, WARMUP);

    const createMs = computeStats(createLat).median;
    const clearMs = computeStats(clearLat).median;
    const savings = createMs > 0 ? ((createMs - clearMs) / createMs * 100) : 0;

    rows.push([
      `${COLS}×${h}`,
      String(COLS * h),
      fmtMs(createMs),
      fmtMs(clearMs),
      `${savings.toFixed(0)}%`,
    ]);
  }

  printTable(
    'Grid Allocation — createGrid vs clearGrid (reuse)',
    ['Dimensions', 'Cells', 'createGrid', 'clearGrid', 'Savings'],
    rows,
  );
}

// Allow running standalone
if (process.argv[1]?.endsWith('grid-alloc.ts')) {
  runGridAlloc();
}
