/** Profiles layout sub-operations: full layout, clearLayout, wrapText, wrapSegments. */
import { layout, clearLayout, wrapText, wrapSegments } from '../../src/tui/layout.js';
import { buildChatTree, buildMarkdownChatTree, collectAllText, collectMarkdownSegments } from '../content.js';
import { measure, computeStats, fmtMs, printTable } from '../harness.js';

const COLS = 120;
const ROWS = 40;
const MESSAGE_COUNTS = [10, 50, 100, 250, 500, 1000];
const ITERATIONS = 200;
const WARMUP = 20;

export async function runLayoutBreakdown(): Promise<void> {
  const rows: string[][] = [];

  for (const msgCount of MESSAGE_COUNTS) {
    // Build trees
    const tree = buildChatTree(msgCount, 0);
    const mdTree = buildMarkdownChatTree(msgCount);

    // Pre-layout so clearLayout has something to clear
    layout(tree, COLS, ROWS);

    // 1. Full layout
    const fullLat = measure(() => {
      clearLayout(tree);
      layout(tree, COLS, ROWS);
    }, ITERATIONS, WARMUP);

    // 2. clearLayout only
    layout(tree, COLS, ROWS); // ensure layout fields are set
    const clearLat = measure(() => {
      clearLayout(tree);
    }, ITERATIONS, WARMUP);
    layout(tree, COLS, ROWS); // restore for next measurements

    // 3. wrapText throughput
    const allText = collectAllText(msgCount);
    const wrapTextLat = measure(() => {
      wrapText(allText, COLS);
    }, ITERATIONS, WARMUP);

    // 4. wrapSegments throughput
    const segments = collectMarkdownSegments(msgCount);
    const wrapSegLat = measure(() => {
      wrapSegments(segments, COLS);
    }, ITERATIONS, WARMUP);

    const fullMs = computeStats(fullLat).median;
    const clearMs = computeStats(clearLat).median;
    const wrapTextMs = computeStats(wrapTextLat).median;
    const wrapSegMs = computeStats(wrapSegLat).median;

    rows.push([
      String(msgCount),
      fmtMs(fullMs),
      fmtMs(clearMs),
      fmtMs(wrapTextMs),
      fmtMs(wrapSegMs),
      `${allText.length} chars`,
      `${segments.length} segs`,
    ]);
  }

  printTable(
    'Layout Breakdown — what layout is doing as content grows',
    ['Messages', 'Full layout', 'clearLayout', 'wrapText', 'wrapSegments', 'Text size', 'Segment count'],
    rows,
  );
}

// Allow running standalone
if (process.argv[1]?.endsWith('layout-breakdown.ts')) {
  runLayoutBreakdown();
}
