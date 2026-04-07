/** Profiles layout sub-operations: full layout, wrapText, wrapSegments. */
import { wrapText, wrapSegments } from '../../src/core/layout.js';
import { createFlexNodeFactory } from '../../src/layout/yoga-flex.js';
import { buildChatTree, collectAllText, collectMarkdownSegments } from '../content.js';
import { measure, computeStats, fmtMs, printTable } from '../harness.js';

const COLS = 120;
const MESSAGE_COUNTS = [10, 50, 100, 250, 500, 1000];
const ITERATIONS = 50;
const WARMUP = 5;

function doLayout(tree: { flexNode?: { setWidth: (w: number) => void; calculateLayout: (w: number) => void } }): void {
  tree.flexNode!.setWidth(COLS);
  tree.flexNode!.calculateLayout(COLS);
}

/** Find all text nodes (leaves with measure functions) to invalidate layout. */
function collectTextNodes(node: any): any[] {
  if (node.type === 'text') return [node];
  const result: any[] = [];
  for (const child of node.children ?? []) {
    result.push(...collectTextNodes(child));
  }
  return result;
}

/** Mark all text nodes dirty so Yoga fully recalculates. */
function invalidateLayout(textNodes: any[]): void {
  for (const node of textNodes) {
    node.flexNode!.markDirty();
  }
}

export async function runLayoutBreakdown(): Promise<void> {
  const rows: string[][] = [];
  const factory = createFlexNodeFactory();

  for (const msgCount of MESSAGE_COUNTS) {
    // Build tree with flex nodes
    const tree = buildChatTree(msgCount, 0, undefined, factory);

    // Pre-layout
    doLayout(tree);

    // 1. Full layout — mark text nodes dirty before each iteration so Yoga
    //    recalculates rather than hitting its "nothing changed" fast path.
    //    Yoga only allows markDirty() on leaf nodes with measure functions.
    const textNodes = collectTextNodes(tree);
    const fullLat = measure(() => {
      invalidateLayout(textNodes);
      doLayout(tree);
    }, ITERATIONS, WARMUP);

    // 2. wrapText throughput
    const allText = collectAllText(msgCount);
    const wrapTextLat = measure(() => {
      wrapText(allText, COLS);
    }, ITERATIONS, WARMUP);

    // 3. wrapSegments throughput
    const segments = collectMarkdownSegments(msgCount);
    const wrapSegLat = measure(() => {
      wrapSegments(segments, COLS);
    }, ITERATIONS, WARMUP);

    const fullMs = computeStats(fullLat).median;
    const wrapTextMs = computeStats(wrapTextLat).median;
    const wrapSegMs = computeStats(wrapSegLat).median;

    rows.push([
      String(msgCount),
      fmtMs(fullMs),
      fmtMs(wrapTextMs),
      fmtMs(wrapSegMs),
      `${allText.length} chars`,
      `${segments.length} segs`,
    ]);
  }

  printTable(
    'Layout Breakdown — what layout is doing as content grows',
    ['Messages', 'Full layout', 'wrapText', 'wrapSegments', 'Text size', 'Segment count'],
    rows,
  );
}

// Allow running standalone
if (process.argv[1]?.endsWith('layout-breakdown.ts')) {
  runLayoutBreakdown();
}
