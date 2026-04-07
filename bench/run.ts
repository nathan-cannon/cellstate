/**
 * Benchmark runner. Run all: `npx tsx bench/run.ts`
 * Run one: `npx tsx bench/run.ts pipeline`
 */
import { runPipelineBreakdown } from './internals/pipeline-breakdown.js';
import { runLayoutBreakdown } from './internals/layout-breakdown.js';
import { runBufferOps } from './internals/buffer-ops.js';
import { runGrowthFrame } from './internals/growth-frame.js';
import { runStreamingSimulation, runMarkdownStreamingSimulation } from './scenarios/streaming-simulation.js';
import { runResize } from './scenarios/resize.js';
import { runComponentMount } from './scenarios/component-mount.js';
import { runBackpressure } from './scenarios/backpressure.js';
import { runBulkUpdate } from './scenarios/bulk-update.js';
import { initTreeSitter } from '../src/markdown/tree-sitter-init.js';

const benchmarks: Record<string, () => Promise<void>> = {
  'pipeline': runPipelineBreakdown,
  'layout': runLayoutBreakdown,
  'buffer-ops': runBufferOps,
  'growth': runGrowthFrame,
  'streaming': runStreamingSimulation,
  'streaming-md': runMarkdownStreamingSimulation,
  'resize': runResize,
  'mount': runComponentMount,
  'backpressure': runBackpressure,
  'bulk': runBulkUpdate,
};

async function main() {
  if (typeof globalThis.gc !== 'function') {
    console.warn('⚠ Run with --expose-gc for more stable measurements');
    console.warn('  npx tsx --expose-gc bench/run.ts\n');
  }

  // Pre-download tree-sitter grammars for syntax highlighting in markdown benchmarks
  await initTreeSitter();

  console.log('CellState Internal Benchmarks');
  console.log(`Terminal: 120×40 | Node ${process.version}\n`);

  const arg = process.argv[2];
  if (arg) {
    const fn = benchmarks[arg];
    if (!fn) {
      console.error(`Unknown benchmark: ${arg}. Available: ${Object.keys(benchmarks).join(', ')}`);
      process.exit(1);
    }
    await fn();
  } else {
    // Run all
    console.log('── Internals ──');
    await runPipelineBreakdown();
    await runLayoutBreakdown();
    await runBufferOps();
    await runGrowthFrame();

    console.log('── Scenarios ──');
    await runStreamingSimulation();
    await runMarkdownStreamingSimulation();
    await runResize();
    await runComponentMount();
    await runBackpressure();
    await runBulkUpdate();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
